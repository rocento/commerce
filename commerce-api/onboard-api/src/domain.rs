use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

const RESERVED_SLUGS: &[&str] = &[
    "admin",
    "clients",
    "onboarding",
    "api",
    "www",
    "billing",
    "support",
    "ingress",
    "mail",
    "static",
    "assets",
    "security",
    "status",
    "docs",
    "cdn",
    "auth",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Principal {
    pub subject: String,
    pub audience: String,
    #[serde(rename = "orgId")]
    pub org_id: Option<String>,
    pub permissions: Vec<String>,
    #[serde(rename = "emailVerified", skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
}

impl Principal {
    pub fn customer(subject: impl Into<String>, org_id: impl Into<String>) -> Self {
        Self {
            subject: subject.into(),
            audience: "customer".to_owned(),
            org_id: Some(org_id.into()),
            permissions: Vec::new(),
            email_verified: None,
        }
    }
}

pub fn require_organization(principal: &Principal) -> ApiResult<&str> {
    if principal.audience != "customer" {
        return Err(ApiError::forbidden("FORBIDDEN"));
    }
    principal
        .org_id
        .as_deref()
        .ok_or_else(|| ApiError::forbidden("FORBIDDEN"))
}

pub fn normalize_slug(value: &str) -> ApiResult<String> {
    let slug = value
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let bytes = slug.as_bytes();
    let valid = (3..=40).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    if !valid {
        return Err(ApiError::bad("INVALID_SLUG"));
    }
    if RESERVED_SLUGS.contains(&slug.as_str()) || slug.ends_with("-admin") {
        return Err(ApiError::bad("RESERVED_SLUG"));
    }
    Ok(slug)
}

pub fn hostnames(slug: &str) -> Value {
    json!({
        "storefront": format!("{slug}.rocento.com"),
        "admin": format!("{slug}-admin.rocento.com")
    })
}

pub fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

pub fn plans() -> Value {
    json!([
        {"id":"LAUNCH","name":"Launch","priceMinor":7900,"maxTenants":3,"currency":"USD","pricingStatus":"PROPOSED"},
        {"id":"GROWTH","name":"Growth","priceMinor":14900,"maxTenants":3,"currency":"USD","pricingStatus":"PROPOSED"},
        {"id":"ENTERPRISE","name":"Enterprise","priceMinor":39900,"maxTenants":1,"currency":"USD","pricingStatus":"PROPOSED"}
    ])
}

pub fn themes() -> Value {
    json!([
        {"id":"pharmacy","name":"Pharmacy & Skincare","description":"Thoughtful care. Everyday essentials.","image":"/themes/pharmacy-ivory.webp","status":"DISCOVERED","demoUrl":null,"artifactDigest":null},
        {"id":"jewelry","name":"Jewelry","description":"Considered details. Refined discovery.","image":"/themes/jewelry-ivory.webp","status":"DISCOVERED","demoUrl":null,"artifactDigest":null},
        {"id":"grocery","name":"Grocery","description":"Fresh discovery. Familiar essentials.","image":"/themes/grocery-ivory.webp","status":"DISCOVERED","demoUrl":null,"artifactDigest":null},
        {"id":"electronics","name":"Electronics","description":"Useful innovation. Everyday connections.","image":"/themes/electronics-ivory.webp","status":"DISCOVERED","demoUrl":null,"artifactDigest":null}
    ])
}

pub fn is_plan(value: &str) -> bool {
    matches!(value, "LAUNCH" | "GROWTH" | "ENTERPRISE")
}

pub fn is_theme(value: &str) -> bool {
    matches!(value, "pharmacy" | "jewelry" | "grocery" | "electronics")
}

pub fn uuid_not_found() -> ApiError {
    ApiError::new("NOT_FOUND", StatusCode::NOT_FOUND)
}
