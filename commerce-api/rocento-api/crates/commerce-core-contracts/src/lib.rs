//! Internal compatibility-fixture validator. This does not authorize commerce actions.
use serde_json::Value;
use std::sync::OnceLock;

pub fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../contract/v1/schema.json"))
            .expect("generated core schema")
    })
}

/// Closed JSON Schema subset emitted by our generator. Unknown keywords fail closed.
pub fn validates(value: &Value, contract: &str) -> bool {
    schema()["$defs"]
        .get(contract)
        .is_some_and(|s| validate(value, s, schema()))
}

fn validate(value: &Value, rule: &Value, root: &Value) -> bool {
    let Some(object) = rule.as_object() else {
        return false;
    };
    let supported = [
        "$ref",
        "type",
        "const",
        "enum",
        "anyOf",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "pattern",
        "minimum",
        "maximum",
        "title",
        "description",
        "default",
    ];
    if object.keys().any(|key| !supported.contains(&key.as_str())) {
        return false;
    }
    if let Some(reference) = rule["$ref"].as_str() {
        return reference
            .strip_prefix("#/$defs/")
            .and_then(|name| root["$defs"].get(name))
            .is_some_and(|s| validate(value, s, root));
    }
    if let Some(expected) = object.get("const") {
        if value != expected {
            return false;
        }
    }
    if let Some(options) = rule["enum"].as_array() {
        if !options.contains(value) {
            return false;
        }
    }
    if let Some(options) = rule["anyOf"].as_array() {
        return options.iter().any(|s| validate(value, s, root));
    }
    match rule["type"].as_str() {
        Some("null") => value.is_null(),
        Some("boolean") => value.is_boolean(),
        Some("integer") | Some("number") => {
            if rule["type"] == "integer" && !(value.is_i64() || value.is_u64()) {
                return false;
            }
            let Some(number) = value.as_f64() else {
                return false;
            };
            number.is_finite()
                && rule["minimum"].as_f64().is_none_or(|min| number >= min)
                && rule["maximum"].as_f64().is_none_or(|max| number <= max)
        }
        Some("string") => {
            let Some(text) = value.as_str() else {
                return false;
            };
            let length = text.chars().count() as u64;
            rule["minLength"].as_u64().is_none_or(|min| length >= min)
                && rule["maxLength"].as_u64().is_none_or(|max| length <= max)
                && rule["pattern"].as_str().is_none_or(|pattern| {
                    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(text))
                })
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return false;
            };
            rule["minItems"]
                .as_u64()
                .is_none_or(|min| items.len() as u64 >= min)
                && rule["maxItems"]
                    .as_u64()
                    .is_none_or(|max| items.len() as u64 <= max)
                && items
                    .iter()
                    .all(|item| validate(item, &rule["items"], root))
        }
        Some("object") => {
            let (Some(fields), Some(properties)) =
                (value.as_object(), rule["properties"].as_object())
            else {
                return false;
            };
            if rule["additionalProperties"] != false {
                return false;
            }
            rule["required"].as_array().is_none_or(|required| {
                required
                    .iter()
                    .all(|k| k.as_str().is_some_and(|key| fields.contains_key(key)))
            }) && fields
                .iter()
                .all(|(key, item)| properties.get(key).is_some_and(|s| validate(item, s, root)))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_python_rust_typescript_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../contract/v1/fixtures.json")).unwrap();
        assert!(fixtures.len() > 300);
        for fixture in &fixtures {
            assert_eq!(
                validates(&fixture["value"], fixture["contract"].as_str().unwrap()),
                fixture["valid"].as_bool().unwrap(),
                "{}",
                fixture["id"]
            );
        }
    }
    #[test]
    fn shared_meaning_wire_fixtures() {
        let root: Value = serde_json::from_str(include_str!(
            "../../../../../commerce-assistant-platform/contracts/commerce-meaning/v1/schema.json"
        ))
        .unwrap();
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../../commerce-assistant-platform/contracts/commerce-meaning/v1/fixtures.json"
        ))
        .unwrap();
        assert!(fixtures.len() > 100);
        for fixture in &fixtures {
            let contract = fixture["contract"].as_str().unwrap();
            assert_eq!(
                validate(&fixture["value"], &root["$defs"][contract], &root),
                fixture["valid"].as_bool().unwrap(),
                "{}",
                fixture["id"]
            );
        }
    }
    #[test]
    fn shared_planning_wire_fixtures() {
        let root: Value = serde_json::from_str(include_str!(
            "../../../../../commerce-assistant-platform/contracts/commerce-planning/v1/schema.json"
        ))
        .unwrap();
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../../commerce-assistant-platform/contracts/commerce-planning/v1/fixtures.json"
        ))
        .unwrap();
        assert!(fixtures.len() > 100);
        for fixture in &fixtures {
            let contract = fixture["contract"].as_str().unwrap();
            assert_eq!(
                validate(&fixture["value"], &root["$defs"][contract], &root),
                fixture["valid"].as_bool().unwrap(),
                "{}",
                fixture["id"]
            );
        }
    }
    #[test]
    fn unknown_contract_or_schema_constraint_fails_closed() {
        assert!(!validates(&serde_json::json!({}), "Unknown"));
        assert!(!validate(
            &serde_json::json!("x"),
            &serde_json::json!({"type":"string","unimplementedConstraint":true}),
            schema()
        ));
    }
}
