pub mod asset_library;
pub mod enrollment;
pub mod preview;
pub mod service;
pub mod studio;
pub mod validation;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const MAX_BYTES: usize = 131_072;
pub const SCHEMA: &str = include_str!("../contract/v1/schema.json");
pub const BUILD_SCHEMA: &str = include_str!("../contract/v1/build-manifest.schema.json");

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Mobile access denied")]
    Forbidden,
    #[error("Mobile session is missing, expired or revoked")]
    Unauthorized,
    #[error("Mobile resource not found")]
    NotFound,
    #[error("Revision or idempotency conflict")]
    Conflict,
    #[error("Invalid mobile configuration")]
    Invalid(Vec<Issue>),
    #[error("No compatible published mobile configuration")]
    Incompatible,
    #[error("Mobile request limit reached")]
    RateLimited,
    #[error("Mobile storage unavailable")]
    Storage,
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(error=%error, "mobile storage failed");
        Self::Storage
    }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Issue {
    pub path: String,
    pub code: String,
}
pub fn invalid(path: &str, code: &str) -> Error {
    Error::Invalid(vec![Issue {
        path: path.into(),
        code: code.into(),
    }])
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Staging,
    Production,
}
impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Production => "production",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Android,
}
impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDraft {
    pub expected_revision: i64,
    pub config: Value,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publish {
    pub expected_revision: i64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rollback {
    pub expected_revision: i64,
    pub target_version: i64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueBuild {
    pub platform: Platform,
    pub manifest: Value,
}
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub revision: i64,
    pub config: Value,
}
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: i64,
    pub config: Value,
    pub checksum: String,
    pub published_by: Uuid,
    pub published_at: chrono::DateTime<chrono::Utc>,
    pub rollback_target: Option<i64>,
}
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub id: Uuid,
    pub platform: String,
    pub build_number: i64,
    pub source_commit: String,
    pub manifest_checksum: String,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
/// SHA-256 over serde_json's recursively key-sorted compact representation.
/// Hash served response bytes on clients; do not re-encode JSON in a native language.
pub fn checksum(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value serializes"))
    )
}
pub fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn bytes_checksum(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
