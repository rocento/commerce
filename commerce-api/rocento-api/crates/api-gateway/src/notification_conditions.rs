//! A bounded, typed condition language evaluated only against server-owned facts.
//! There are no executable expressions, nested groups, browser facts, or SQL fragments.
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Conditions {
    #[serde(rename = "match")]
    pub mode: String,
    pub rules: Vec<Rule>,
}
impl Default for Conditions {
    fn default() -> Self {
        Self {
            mode: "all".into(),
            rules: Vec::new(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub field: String,
    pub operator: String,
    pub value: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_currency"
    )]
    pub currency: Option<String>,
}
fn optional_currency<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    // Omission is allowed; an explicit null is not a string-valued currency qualifier.
    String::deserialize(deserializer).map(Some)
}
#[derive(Serialize)]
pub struct ConditionResult {
    pub index: usize,
    pub field: String,
    pub operator: String,
    pub expected: String,
    pub actual: Option<String>,
    pub matched: bool,
    pub reason: String,
}
pub struct Evaluation {
    pub matched: bool,
    pub results: Vec<ConditionResult>,
}
#[derive(Serialize)]
pub struct Operator {
    id: &'static str,
    label: &'static str,
}
#[derive(Serialize)]
pub struct OptionValue {
    value: &'static str,
    label: String,
}
#[derive(Serialize)]
pub struct Field {
    key: &'static str,
    label: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    operators: Vec<Operator>,
    options: Vec<OptionValue>,
    triggers: &'static [&'static str],
    description: &'static str,
}
fn operators(ids: &[&'static str]) -> Vec<Operator> {
    ids.iter()
        .map(|id| Operator {
            id,
            label: match *id {
                "eq" => "Equals",
                "neq" => "Does not equal",
                "gte" => "At least",
                "lte" => "At most",
                "contains" => "Contains",
                _ => unreachable!(),
            },
        })
        .collect()
}
pub fn metadata() -> Vec<Field> {
    vec![
        Field { key:"customer.verified",label:"Customer verification",kind:"boolean",operators:operators(&["eq"]),options:vec![OptionValue{value:"true",label:"Verified".into()},OptionValue{value:"false",label:"Not verified".into()}],triggers:&[],description:"The selected customer's current verification status, checked again during generation." },
        Field { key:"customer.order_count",label:"Customer order count",kind:"integer",operators:operators(&["eq","gte","lte"]),options:vec![],triggers:&[],description:"Lifetime count of all orders belonging to the selected customer, including cancelled orders. Enter a whole number from 0 to 1,000,000,000 without leading zeroes." },
        Field { key:"customer.account_age_days",label:"Customer account age (days)",kind:"integer",operators:operators(&["eq","gte","lte"]),options:vec![],triggers:&[],description:"Whole elapsed 24-hour days since the selected customer's account was created. Future or unavailable creation times never match. Enter 0 to 1,000,000,000 without leading zeroes." },
        Field { key:"product.name",label:"Product name",kind:"text",operators:operators(&["eq","contains"]),options:vec![],triggers:&["product_view","cart.item_added","cart.item_removed"],description:"Product name resolved from the latest matching journey event. Comparisons ignore letter case and preserve spaces. Missing or deleted products never match. Enter 1 to 200 characters." },
        Field { key:"order.status",label:"Recorded order status",kind:"select",operators:operators(&["eq","neq"]),options:domain_orders::statuses::STATES.iter().filter(|value| **value != "placed").map(|value|OptionValue{value,label:state_label(value)}).collect(),triggers:&["order_status"],description:"The lifecycle state recorded on the selected order-status event, not the order's current state or its configurable display label. Missing or unsupported states never match." },
        Field { key:"order.total",label:"Order or checkout total",kind:"money",operators:operators(&["eq","gte","lte"]),options:vec![],triggers:&["checkout","purchase"],description:"The selected checkout quote or placed order's total. Requires its exact three-letter uppercase currency; no conversion is performed. Use 0 to 999999999999.99, with at most two decimal places." },
        Field { key:"order.currency",label:"Order or checkout currency",kind:"text",operators:operators(&["eq"]),options:vec![],triggers:&["checkout","purchase"],description:"Currency recorded on the selected checkout quote or placed order. Enter exactly three uppercase ASCII letters, such as USD or EGP." },
    ]
}
fn state_label(value: &str) -> String {
    let words = value.replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn integer(value: &str) -> Option<i64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}
fn currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|b| b.is_ascii_uppercase())
}
fn money(value: &str) -> Option<Decimal> {
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(whole, fraction)| (whole, Some(fraction)));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.is_some_and(|fraction| {
            fraction.is_empty()
                || fraction.len() > 2
                || !fraction.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return None;
    }
    Decimal::from_str_exact(value)
        .ok()
        .filter(|value| *value >= Decimal::ZERO)
}
pub fn validate(conditions: &Conditions, trigger: &str) -> Result<()> {
    if !["all", "any"].contains(&conditions.mode.as_str())
        || conditions.rules.len() > 10
        || (conditions.mode == "any" && conditions.rules.is_empty())
    {
        return Err(invalid(
            "Choose all or any and use at most 10 conditions; any requires at least one condition",
        ));
    }
    let definitions = metadata();
    for rule in &conditions.rules {
        let field = definitions
            .iter()
            .find(|field| field.key == rule.field)
            .ok_or_else(|| invalid("Unknown notification condition field"))?;
        if !field.triggers.is_empty() && !field.triggers.contains(&trigger) {
            return Err(invalid(
                "A condition field is not available for this trigger",
            ));
        }
        if !field.operators.iter().any(|op| op.id == rule.operator) {
            return Err(invalid(
                "This comparison is not supported for the selected condition field",
            ));
        }
        if rule.value.chars().count() > 200 || rule.value.chars().any(char::is_control) {
            return Err(invalid(
                "Condition values must contain at most 200 characters and no control characters",
            ));
        }
        if rule.field != "order.total" && rule.currency.is_some() {
            return Err(invalid(
                "Only an order-total condition accepts a currency qualifier",
            ));
        }
        let valid = match field.key {
            "customer.verified" => ["true", "false"].contains(&rule.value.as_str()),
            "customer.order_count" | "customer.account_age_days" => {
                integer(&rule.value).is_some_and(|v| (0..=1_000_000_000).contains(&v))
            }
            "product.name" => !rule.value.trim().is_empty(),
            "order.status" => {
                rule.value != "placed"
                    && domain_orders::statuses::STATES.contains(&rule.value.as_str())
            }
            "order.currency" => currency(&rule.value),
            "order.total" => {
                money(&rule.value).is_some_and(|v| v <= Decimal::new(99_999_999_999_999, 2))
                    && rule.currency.as_ref().is_some_and(|v| currency(v))
            }
            _ => false,
        };
        if !valid {
            return Err(invalid(
                "The condition value or required currency is invalid for the selected field",
            ));
        }
    }
    Ok(())
}
fn compare<T: PartialOrd + PartialEq>(actual: T, expected: T, operator: &str) -> bool {
    match operator {
        "eq" => actual == expected,
        "neq" => actual != expected,
        "gte" => actual >= expected,
        "lte" => actual <= expected,
        _ => false,
    }
}
pub fn evaluate(conditions: &Conditions, facts: &BTreeMap<String, String>) -> Evaluation {
    let results:Vec<_>=conditions.rules.iter().enumerate().map(|(index,rule)| {
        let mut actual=facts.get(&rule.field).cloned();
        let expected=if let Some(currency)=&rule.currency {format!("{} {currency}",rule.value)}else{rule.value.clone()};
        let mut matched=false;
        let mut reason="This condition did not match.".to_owned();
        if let Some(value)=actual.clone() {
            match rule.field.as_str() {
                "customer.verified"=>{
                    if ["true","false"].contains(&value.as_str()) {matched=value==rule.value;}else{actual=None;}
                },
                "customer.order_count"|"customer.account_age_days"=>match (integer(&value),integer(&rule.value)) {
                    (Some(actual_value),Some(expected))=>matched=compare(actual_value,expected,&rule.operator),_=>actual=None,
                },
                "product.name"=>{
                    if value.trim().is_empty() || value.chars().any(char::is_control) {actual=None;}else{
                        let actual=value.to_lowercase();let expected=rule.value.to_lowercase();
                        matched=if rule.operator=="contains"{actual.contains(&expected)}else{actual==expected};
                    }
                },
                "order.status"=>{
                    if value != "placed" && domain_orders::statuses::STATES.contains(&value.as_str()) {matched=compare(value,rule.value.clone(),&rule.operator);}else{actual=None;}
                },
                "order.currency"=>if currency(&value) {matched=value==rule.value;}else{actual=None;},
                "order.total"=>match (money(&value),money(&rule.value),facts.get("order.currency").filter(|value|currency(value))) {
                    (Some(actual_value),Some(expected),Some(actual_currency))=>{
                        actual=Some(format!("{value} {actual_currency}"));
                        if rule.currency.as_ref()==Some(actual_currency) {matched=compare(actual_value,expected,&rule.operator);}else{reason="The selected event's currency differs from this condition; no currency conversion is performed.".into();}
                    },
                    _=>actual=None,
                },
                _=>actual=None,
            }
        }
        if actual.is_none() {reason="This fact is unavailable for the selected customer or latest journey event; missing facts never match.".into();}
        if matched {reason="This condition matched.".into();}
        ConditionResult {index,field:rule.field.clone(),operator:rule.operator.clone(),expected,actual,matched,reason}
    }).collect();
    let matched = if conditions.mode == "any" {
        results.iter().any(|result| result.matched)
    } else {
        results.iter().all(|result| result.matched)
    };
    Evaluation { matched, results }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(field: &str, operator: &str, value: &str, currency: Option<&str>) -> Rule {
        Rule {
            field: field.into(),
            operator: operator.into(),
            value: value.into(),
            currency: currency.map(str::to_owned),
        }
    }
    #[test]
    fn legacy_default_and_boolean_groups_are_explicit() {
        let empty = Conditions::default();
        assert!(validate(&empty, "visit").is_ok());
        assert!(evaluate(&empty, &BTreeMap::new()).matched);
        assert!(validate(
            &Conditions {
                mode: "any".into(),
                rules: vec![]
            },
            "visit"
        )
        .is_err());
        let mut conditions = Conditions {
            mode: "all".into(),
            rules: vec![
                rule("customer.verified", "eq", "true", None),
                rule("customer.order_count", "gte", "1", None),
            ],
        };
        let facts = BTreeMap::from([
            ("customer.verified".into(), "true".into()),
            ("customer.order_count".into(), "0".into()),
        ]);
        assert!(!evaluate(&conditions, &facts).matched);
        conditions.mode = "any".into();
        assert!(evaluate(&conditions, &facts).matched);
        let serialized = serde_json::to_value(&conditions).unwrap();
        assert!(serialized["rules"][0].get("currency").is_none());
        assert!(serde_json::from_value::<Rule>(serde_json::json!({"field":"customer.verified","operator":"eq","value":"true","currency":null})).is_err());
    }
    #[test]
    fn missing_or_invalid_facts_never_satisfy_negative_comparisons() {
        let conditions = Conditions {
            mode: "all".into(),
            rules: vec![rule("order.status", "neq", "cancelled", None)],
        };
        for facts in [
            BTreeMap::new(),
            BTreeMap::from([("order.status".into(), "custom-display-label".into())]),
        ] {
            let evaluated = evaluate(&conditions, &facts);
            assert!(!evaluated.matched);
            assert!(evaluated.results[0].actual.is_none());
        }
        assert!(validate(&conditions, "order_status").is_ok());
        assert!(validate(&conditions, "purchase").is_err());
    }
    #[test]
    fn money_is_exact_and_currency_qualified() {
        let conditions = Conditions {
            mode: "all".into(),
            rules: vec![rule("order.total", "eq", "0.30", Some("USD"))],
        };
        assert!(validate(&conditions, "purchase").is_ok());
        let mut facts = BTreeMap::from([
            ("order.total".into(), "0.3".into()),
            ("order.currency".into(), "USD".into()),
        ]);
        assert!(evaluate(&conditions, &facts).matched);
        facts.insert("order.currency".into(), "EGP".into());
        assert!(!evaluate(&conditions, &facts).matched);
        facts.remove("order.currency");
        assert!(evaluate(&conditions, &facts).results[0].actual.is_none());
        for value in [
            "-1",
            "+1",
            ".30",
            "1.",
            "1.001",
            "1e2",
            "1,000",
            " 1",
            "1000000000000.00",
        ] {
            let invalid = Conditions {
                mode: "all".into(),
                rules: vec![rule("order.total", "gte", value, Some("USD"))],
            };
            assert!(validate(&invalid, "checkout").is_err(), "{value}");
        }
        assert!(validate(
            &Conditions {
                mode: "all".into(),
                rules: vec![rule("order.total", "eq", "999999999999.99", Some("USD"))]
            },
            "purchase"
        )
        .is_ok());
    }
    #[test]
    fn field_operator_and_value_validation_is_closed() {
        for invalid in [
            rule("customer.email", "eq", "person@example.test", None),
            rule("customer.verified", "neq", "true", None),
            rule("customer.verified", "eq", "True", None),
            rule("customer.order_count", "gte", "1.5", None),
            rule("customer.order_count", "gte", "1000000001", None),
            rule("customer.order_count", "gte", "1", Some("USD")),
            rule("order.total", "gte", "10", None),
            rule("order.currency", "eq", "usd", None),
            rule("product.name", "contains", " ", None),
        ] {
            assert!(validate(
                &Conditions {
                    mode: "all".into(),
                    rules: vec![invalid]
                },
                "purchase"
            )
            .is_err());
        }
        assert!(validate(
            &Conditions {
                mode: "all".into(),
                rules: vec![rule("customer.verified", "eq", "true", None); 11]
            },
            "visit"
        )
        .is_err());
        let product = Conditions {
            mode: "all".into(),
            rules: vec![rule("product.name", "contains", "APPLE", None)],
        };
        assert!(validate(&product, "product_view").is_ok());
        assert!(
            evaluate(
                &product,
                &BTreeMap::from([("product.name".into(), "Organic Apple".into())])
            )
            .matched
        );
        assert!(metadata()
            .iter()
            .find(|field| field.key == "order.status")
            .unwrap()
            .options
            .iter()
            .any(|option| option.value == "pickup_ready"));
    }
}
