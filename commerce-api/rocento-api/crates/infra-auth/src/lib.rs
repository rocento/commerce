//! Shared security primitives. HTTP mapping belongs to the gateway.
pub mod notifications;
pub mod password;
pub mod retention;
use chrono::Utc;
pub use password::{hash_password, verify_password};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Invalid credentials or expired session")]
    Unauthorized,
    #[error("Permission denied")]
    Forbidden,
    #[error("Record not found")]
    NotFound,
    #[error("Record already exists or is still in use")]
    Conflict,
    #[error("Too many attempts. Please try again in 15 minutes.")]
    RateLimited,
    #[error("Authentication is busy. Please try again shortly.")]
    Busy,
    /// Transitional carrier for typed domain failures without a dependency on
    /// domain crates. The HTTP boundary explicitly recognizes public variants.
    #[error(transparent)]
    Business(Box<dyn std::error::Error + Send + Sync>),
    #[error("Internal service error")]
    Internal,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}
pub fn otp() -> String {
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32))
}
pub fn validate_password(value: &str) -> Result<()> {
    if value.len() < 12 || value.len() > 128 {
        return Err(Error::Invalid("Use a password of 12–128 bytes".into()));
    }
    Ok(())
}
pub fn identifier(value: &str) -> Result<(String, &'static str)> {
    let value = value.trim().to_lowercase();
    if value.len() > 254 {
        return Err(Error::Invalid("Identifier is too long".into()));
    }
    if value.starts_with('+')
        && (9..=16).contains(&value.len())
        && value.as_bytes()[1] != b'0'
        && value[1..].bytes().all(|c| c.is_ascii_digit())
    {
        return Ok((value, "mobile"));
    }
    if let Some((local, domain)) = value.split_once('@') {
        if !local.is_empty()
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !value.chars().any(char::is_whitespace)
            && !domain.contains('@')
        {
            return Ok((value, "email"));
        }
    }
    Err(Error::Invalid(
        "Enter a valid email or mobile number in E.164 format (for example +201012345678)".into(),
    ))
}
pub fn bounded(value: &str, name: &str, max: usize, required: bool) -> Result<()> {
    if value.len() > max || (required && value.trim().is_empty()) {
        return Err(Error::Invalid(format!(
            "{name} is required and must be at most {max} bytes"
        )));
    }
    Ok(())
}
/// Atomic, shared across gateway instances. Keys are hashed; identifiers are never stored here.
pub async fn rate_limit(pool: &PgPool, key: &str, limit: i32) -> Result<()> {
    let attempts: i32 = sqlx::query_scalar("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN platform.rate_limits.window_start < clock_timestamp()-interval '15 minutes' THEN 1 ELSE LEAST(platform.rate_limits.attempts::bigint+1,2147483647)::integer END, window_start=CASE WHEN platform.rate_limits.window_start < clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE platform.rate_limits.window_start END RETURNING attempts")
        .bind(digest(key)).fetch_one(pool).await?;
    if attempts > limit {
        return Err(Error::RateLimited);
    }
    Ok(())
}

/// Shared admission across replicas. Rejected clients never consume another
/// bucket's allowance. Stable key ordering avoids deadlocks between overlapping
/// subject/source/installation budgets. No raw identifiers are persisted.
pub async fn admit(pool: &PgPool, buckets: &[(String, i32)]) -> Result<()> {
    if buckets.is_empty() || buckets.len() > 4 || buckets.iter().any(|(_, limit)| *limit < 1) {
        return Err(Error::Internal);
    }
    let mut buckets: Vec<_> = buckets
        .iter()
        .map(|(key, limit)| (digest(key), *limit))
        .collect();
    buckets.sort_unstable();
    if buckets.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(Error::Internal);
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','2s',true)",
    )
    .execute(&mut *tx)
    .await?;
    for (key, limit) in buckets {
        let accepted: Option<i32> = sqlx::query_scalar("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN platform.rate_limits.window_start < clock_timestamp()-interval '15 minutes' THEN 1 ELSE platform.rate_limits.attempts+1 END, window_start=CASE WHEN platform.rate_limits.window_start < clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE platform.rate_limits.window_start END WHERE platform.rate_limits.window_start < clock_timestamp()-interval '15 minutes' OR platform.rate_limits.attempts < $2 RETURNING attempts")
            .bind(key).bind(limit).fetch_optional(&mut *tx).await?;
        if accepted.is_none() {
            return Err(Error::RateLimited);
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Notification {
    pub identifier: String,
    pub purpose: String,
    pub code: String,
    pub link: String,
    pub mobile: bool,
}
pub trait NotificationSink: Send + Sync {
    fn send(&self, notification: Notification);
}
pub struct ConsoleNotifications;
impl NotificationSink for ConsoleNotifications {
    fn send(&self, n: Notification) {
        tracing::info!(target:"local_notifications", identifier=%n.identifier, purpose=%n.purpose, code=%n.code, link=%n.link, mobile=n.mobile, "LOCAL DELIVERY — expires in 15 minutes");
    }
}
#[derive(Clone)]
pub struct Security {
    pub secret: String,
    pub dummy_hash: String,
    pub storefront_url: String,
    pub secure_cookies: bool,
    pub notifications: std::sync::Arc<dyn NotificationSink>,
    pub queued_notifications: bool,
    pub email_notifications_only: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub sid: Uuid,
    pub exp: usize,
    pub iss: String,
    pub aud: String,
}
impl Security {
    pub async fn new(secret: String, storefront_url: String, secure_cookies: bool) -> Result<Self> {
        if secret.len() < 32 {
            return Err(Error::Invalid(
                "AUTH_SECRET must contain at least 32 random characters".into(),
            ));
        }
        Ok(Self {
            secret,
            dummy_hash: hash_password(token()).await?,
            storefront_url,
            secure_cookies,
            notifications: std::sync::Arc::new(ConsoleNotifications),
            queued_notifications: false,
            email_notifications_only: false,
        })
    }
    pub fn access_token(&self, customer: Uuid, session: Uuid) -> Result<String> {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &Claims {
                sub: customer,
                sid: session,
                exp: (Utc::now().timestamp() + 900) as usize,
                iss: "commerce".into(),
                aud: "customer".into(),
            },
            &jsonwebtoken::EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .map_err(|_| Error::Internal)
    }
    pub fn decode(&self, value: &str) -> Result<Claims> {
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.set_issuer(&["commerce"]);
        validation.set_audience(&["customer"]);
        jsonwebtoken::decode::<Claims>(
            value,
            &jsonwebtoken::DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        )
        .map(|v| v.claims)
        .map_err(|_| Error::Unauthorized)
    }
    pub fn challenge_hash(&self, customer: Uuid, purpose: &str, code: &str) -> String {
        // Secret prefix prevents offline enumeration of the six-digit verification space.
        digest(&format!("{}:{customer}:{purpose}:{code}", self.secret))
    }
    /// Build a message for either the local sink or durable test inbox queue.
    pub fn notification(
        &self,
        identifier: &str,
        purpose: &str,
        code: &str,
        mobile: bool,
    ) -> Notification {
        let path = if purpose == "verify" {
            "verify"
        } else {
            "reset-password"
        };
        let encoded: String = identifier
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        Notification {
            identifier: identifier.into(),
            purpose: purpose.into(),
            code: code.into(),
            mobile,
            link: format!(
                "{}/{path}?token={code}&identifier={encoded}",
                self.storefront_url
            ),
        }
    }
    pub fn deliver(&self, identifier: &str, purpose: &str, code: &str, mobile: bool) {
        if !self.queued_notifications {
            self.notifications
                .send(self.notification(identifier, purpose, code, mobile));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn password_hashes_are_salted_and_verified() {
        let p = "Twelve characters!".to_string();
        let a = hash_password(p.clone()).await.unwrap();
        let b = hash_password(p.clone()).await.unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("$argon2id$"));
        assert!(verify_password(p, a.clone()).await.unwrap());
        assert!(!verify_password("wrong".into(), a).await.unwrap());
    }
    #[test]
    fn identifiers_are_normalized_and_validated() {
        assert_eq!(
            identifier(" A@Example.com ").unwrap(),
            ("a@example.com".into(), "email")
        );
        assert!(identifier("+201012345678").is_ok());
        assert!(identifier("+00123").is_err());
        assert!(identifier("a@b@c.com").is_err());
        assert!(identifier("").is_err());
    }
    #[tokio::test]
    async fn jwt_rejects_other_keys() {
        let a = Security::new("a".repeat(48), "http://localhost".into(), false)
            .await
            .unwrap();
        let b = Security::new("b".repeat(48), "http://localhost".into(), false)
            .await
            .unwrap();
        let token = a.access_token(Uuid::new_v4(), Uuid::new_v4()).unwrap();
        assert!(a.decode(&token).is_ok());
        assert!(b.decode(&token).is_err());
    }
}
