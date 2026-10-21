//! Versioned catalog behavior; no industry-specific branching.
use crate::{bad, Definition};
use infra_auth::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Metadata {
    pub description: String,
    pub status: String,
    pub admin_visible: bool,
    pub facetable: bool,
    pub sortable: bool,
    pub ai_queryable: bool,
    pub ai_enrichable: bool,
    /// factual: authoritative catalog facts; semantic: qualitative tags; trusted_only: no inference.
    pub source_policy: String,
    pub unit: Option<String>,
    pub semantic_role: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub max_length: Option<usize>,
    pub default_value: Option<Value>,
    pub display_order: i32,
}
impl Default for Metadata {
    fn default() -> Self {
        Self {
            description: String::new(),
            status: "active".into(),
            admin_visible: true,
            facetable: false,
            sortable: false,
            ai_queryable: false,
            ai_enrichable: false,
            source_policy: "factual".into(),
            unit: None,
            semantic_role: None,
            min: None,
            max: None,
            max_length: None,
            default_value: None,
            display_order: 0,
        }
    }
}
impl Metadata {
    pub fn active(&self) -> bool {
        self.status == "active"
    }
    pub fn validate(&self, d: &Definition) -> Result<()> {
        if !["active", "disabled"].contains(&self.status.as_str())
            || !["factual", "semantic", "trusted_only"].contains(&self.source_policy.as_str())
            || self.description.len() > 2000
            || self
                .unit
                .as_ref()
                .is_some_and(|u| u.is_empty() || u.len() > 30)
            || self.display_order < 0
            || self.max_length.is_some_and(|v| v == 0 || v > 4000)
            || self.min.zip(self.max).is_some_and(|(a, b)| a > b)
            || self.min.is_some_and(|v| !v.is_finite())
            || self.max.is_some_and(|v| !v.is_finite())
            || self
                .semantic_role
                .as_ref()
                .is_some_and(|r| !["classification", "brand", "intended_use"].contains(&r.as_str()))
            || (self.ai_enrichable
                && (self.source_policy != "semantic" || d.used_for_configurations))
            || (self.facetable && !d.is_filterable)
            || (self.sortable
                && !matches!(
                    d.input_type.as_str(),
                    "integer" | "decimal" | "measurement" | "price" | "date" | "datetime"
                ))
            || (d.input_type == "measurement" && self.unit.is_none())
            || (d.is_required && !self.admin_visible)
        {
            return Err(bad("Invalid attribute metadata or source policy"));
        }
        if let Some(value) = &self.default_value {
            crate::validate_value(d, value)?;
        }
        Ok(())
    }
}
pub fn canonical_type(kind: &str) -> &str {
    match kind {
        "long_text" => "textarea",
        "single_select" => "select",
        "multi_select" => "multiselect",
        _ => kind,
    }
}
pub fn filter_value(d: &Definition, value: &Value) -> Result<()> {
    if let Some(values) = value.as_array() {
        if values.is_empty() || values.len() > 50 {
            return Err(bad("Select between 1 and 50 attribute values"));
        }
        for value in values {
            if value.is_array() || value.is_object() || value.is_null() {
                return Err(bad("Filter alternatives must be scalar"));
            }
            filter_value(d, value)?;
        }
        Ok(())
    } else if matches!(canonical_type(&d.input_type), "multiselect") {
        crate::validate_value(d, &serde_json::json!([value]))
    } else {
        crate::validate_value(d, value)
    }
}
