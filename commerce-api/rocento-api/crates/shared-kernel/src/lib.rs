//! Shared contracts only; domain behavior belongs in its owning crate.
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

impl Default for HealthResponse {
    fn default() -> Self {
        Self { status: "ok" }
    }
}
