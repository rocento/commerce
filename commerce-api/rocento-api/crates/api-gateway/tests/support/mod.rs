use serde_json::Value;

mod signing;
pub use signing::{assistant_private_key, assistant_public_key};

/// Runtime shape checks. Python OpenAPI validators in CI own dialect/format
/// validation; this helper must still respect OpenAPI 3.0 reference semantics.
pub fn validate_shape(value: &Value, schema: &Value, contract: &Value) {
    if let Err(error) = check_shape(value, schema, contract) {
        panic!("response violates contract: {error}");
    }
}

fn check_shape(value: &Value, schema: &Value, contract: &Value) -> Result<(), String> {
    if schema.as_object().is_some_and(|object| object.is_empty()) {
        return Ok(());
    }
    // OpenAPI 3.0 ignores all Reference Object siblings, including nullable.
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return check_shape(
            value,
            contract
                .pointer(reference.trim_start_matches('#'))
                .ok_or_else(|| format!("unresolved {reference}"))?,
            contract,
        );
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err("value outside contract enum".into());
        }
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        for part in parts {
            check_shape(value, part, contract)?;
        }
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(parts) = schema.get(keyword).and_then(Value::as_array) {
            let matches = parts
                .iter()
                .filter(|part| check_shape(value, part, contract).is_ok())
                .count();
            if matches == 0 || (keyword == "oneOf" && matches != 1) {
                return Err(format!("{keyword} matched {matches} alternatives"));
            }
        }
    }
    // Nullable modifies only an explicit type; it cannot bypass enum/allOf.
    if value.is_null() && schema["nullable"] == true && schema.get("type").is_some() {
        return Ok(());
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let object = value.as_object().ok_or("expected object")?;
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required {
                    if !object.contains_key(key.as_str().ok_or("invalid required key")?) {
                        return Err(format!("missing {key}"));
                    }
                }
            }
            for (key, value) in object {
                if let Some(property) = schema["properties"].get(key) {
                    check_shape(value, property, contract).map_err(|e| format!("{key}: {e}"))?;
                } else if schema["additionalProperties"] == false {
                    return Err(format!("unexpected field {key}"));
                } else if schema["additionalProperties"].is_object() {
                    check_shape(value, &schema["additionalProperties"], contract)?;
                }
            }
        }
        Some("array") => {
            for item in value.as_array().ok_or("expected array")? {
                check_shape(item, &schema["items"], contract)?;
            }
        }
        Some("string") if value.is_string() => {}
        Some("boolean") if value.is_boolean() => {}
        Some("number") if value.is_number() => {}
        Some("integer") if value.is_i64() || value.is_u64() => {}
        None if ["allOf", "anyOf", "oneOf"]
            .iter()
            .any(|key| schema.get(key).is_some()) => {}
        other => return Err(format!("expected {other:?}, got {value}")),
    }
    Ok(())
}

#[test]
fn nullability_respects_reference_and_composition_rules() {
    let contract = serde_json::json!({"components":{"schemas":{"Object":{"type":"object"}}}});
    let reference = serde_json::json!({"$ref":"#/components/schemas/Object","nullable":true});
    assert!(check_shape(&Value::Null, &reference, &contract).is_err());
    let nullable =
        serde_json::json!({"anyOf":[reference,{"type":"object","nullable":true,"enum":[null]}]});
    assert!(check_shape(&Value::Null, &nullable, &contract).is_ok());
    assert!(check_shape(&serde_json::json!({}), &nullable, &contract).is_ok());
    assert!(check_shape(&serde_json::json!("wrong"), &nullable, &contract).is_err());
}
