use std::sync::Arc;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::{rngs::OsRng, RngCore};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgConnection, PgPool, Row};
use tokio::{sync::Semaphore, task};
use uuid::Uuid;

use crate::{
    domain::Principal,
    error::{ApiError, ApiResult},
};

#[derive(Clone)]
pub struct SecretBox {
    key: [u8; 32],
}

impl SecretBox {
    pub fn new(key: &str) -> Result<Self, Box<dyn std::error::Error>> {
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("AUTH_MAIL_KEY must be 32 random bytes encoded as hex".into());
        }
        let decoded = hex::decode(key)?;
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&decoded);
        Ok(Self { key: bytes })
    }

    pub fn seal(&self, value: &Value) -> ApiResult<String> {
        let key = UnboundKey::new(&AES_256_GCM, &self.key).map_err(|_| ApiError::unavailable())?;
        let cipher = LessSafeKey::new(key);
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let nonce_value = Nonce::assume_unique_for_key(nonce);
        let mut encrypted = value.to_string().into_bytes();
        cipher
            .seal_in_place_append_tag(nonce_value, Aad::empty(), &mut encrypted)
            .map_err(|_| ApiError::unavailable())?;
        if encrypted.len() < 16 {
            return Err(ApiError::unavailable());
        }
        // Keep the on-disk format compatible with the previous Node AES-GCM worker:
        // nonce || auth tag || ciphertext, encoded as base64.
        let split = encrypted.len() - 16;
        let mut bytes = Vec::with_capacity(12 + encrypted.len());
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&encrypted[split..]);
        bytes.extend_from_slice(&encrypted[..split]);
        Ok(BASE64.encode(bytes))
    }

    pub fn open(&self, value: &str) -> ApiResult<Value> {
        let bytes = BASE64.decode(value).map_err(|_| ApiError::unavailable())?;
        if bytes.len() < 28 {
            return Err(ApiError::unavailable());
        }
        let key = UnboundKey::new(&AES_256_GCM, &self.key).map_err(|_| ApiError::unavailable())?;
        let cipher = LessSafeKey::new(key);
        let mut encrypted = Vec::with_capacity(bytes.len() - 12);
        encrypted.extend_from_slice(&bytes[28..]);
        encrypted.extend_from_slice(&bytes[12..28]);
        let nonce = <[u8; 12]>::try_from(&bytes[..12]).map_err(|_| ApiError::unavailable())?;
        let clear = cipher
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::empty(),
                &mut encrypted,
            )
            .map_err(|_| ApiError::unavailable())?;
        serde_json::from_slice(&clear).map_err(|_| ApiError::unavailable())
    }
}

#[derive(Clone)]
pub struct Accounts {
    db: PgPool,
    box_: SecretBox,
    password_slots: Arc<Semaphore>,
    dummy_hash: String,
}

impl Accounts {
    pub fn new(db: PgPool, box_: SecretBox) -> Result<Self, Box<dyn std::error::Error>> {
        let mut dummy = [0u8; 32];
        OsRng.fill_bytes(&mut dummy);
        let dummy_hash = hash_password(&hex::encode(dummy))
            .map_err(|_| std::io::Error::other("could not initialize password verifier"))?;
        Ok(Self {
            db,
            box_,
            password_slots: Arc::new(Semaphore::new(2)),
            dummy_hash,
        })
    }

    async fn password_work<T, F>(&self, work: F) -> ApiResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> ApiResult<T> + Send + 'static,
    {
        let _permit = self
            .password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new("AUTH_BUSY", StatusCode::SERVICE_UNAVAILABLE))?;
        task::spawn_blocking(work).await.map_err(|error| {
            tracing::error!(%error, "password worker failed");
            ApiError::unavailable()
        })?
    }

    async fn limit(&self, key: &str, max: i32) -> ApiResult<()> {
        let hashed = digest(key);
        let row = sqlx::query(
            "INSERT INTO auth_limits(key,count,expires_at) VALUES($1,1,clock_timestamp()+interval '15 minutes') \
             ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_limits.expires_at<=clock_timestamp() THEN 1 ELSE auth_limits.count+1 END, \
             expires_at=CASE WHEN auth_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '15 minutes' ELSE auth_limits.expires_at END RETURNING count",
        )
        .bind(hashed)
        .fetch_one(&self.db)
        .await?;
        let count: i32 = row.try_get("count").map_err(|_| ApiError::unavailable())?;
        if count > max {
            return Err(ApiError::new(
                "TOO_MANY_ATTEMPTS",
                StatusCode::TOO_MANY_REQUESTS,
            ));
        }
        Ok(())
    }

    async fn challenge(
        &self,
        tx: &mut PgConnection,
        account_id: Uuid,
        address: &str,
        purpose: &str,
    ) -> ApiResult<()> {
        let token = random_hex(32);
        let id = Uuid::new_v4();
        sqlx::query("DELETE FROM account_challenges WHERE account_id=$1 AND purpose=$2")
            .bind(account_id)
            .bind(purpose)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO account_challenges(id,account_id,purpose,token_hash,expires_at) \
             VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",
        )
        .bind(id)
        .bind(account_id)
        .bind(purpose)
        .bind(digest(&token))
        .execute(&mut *tx)
        .await?;
        let payload = json!({"email":address,"token":token,"purpose":purpose});
        let encrypted = self.box_.seal(&payload)?;
        sqlx::query("INSERT INTO auth_deliveries(id,encrypted_payload) VALUES($1,$2)")
            .bind(id)
            .bind(encrypted)
            .execute(&mut *tx)
            .await?;
        Ok(())
    }

    pub async fn register(&self, body: &Value) -> ApiResult<Value> {
        let address = email(body.get("identifier"))?;
        let pass = password(body.get("password"))?;
        self.limit(&format!("register:{address}"), 5).await?;
        let encoded = self.password_work(move || hash_password(&pass)).await?;

        let mut tx = self.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(&address)
            .execute(&mut *tx)
            .await?;
        let existing = sqlx::query("SELECT id FROM customer_accounts WHERE email=$1")
            .bind(&address)
            .fetch_optional(&mut *tx)
            .await?;
        if existing.is_none() {
            let account_id = Uuid::new_v4();
            let org_id = Uuid::new_v4();
            sqlx::query("INSERT INTO organizations(id,name) VALUES($1,'New organization')")
                .bind(org_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO customer_accounts(id,org_id,email,password_hash) VALUES($1,$2,$3,$4)",
            )
            .bind(account_id)
            .bind(org_id)
            .bind(&address)
            .bind(encoded)
            .execute(&mut *tx)
            .await?;
            self.challenge(&mut tx, account_id, &address, "verify")
                .await?;
            sqlx::query(
                "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'account.registered',$2)",
            )
            .bind(account_id.to_string())
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(json!({"status":"CHECK_EMAIL"}))
    }

    pub async fn request(&self, body: &Value, purpose: &str) -> ApiResult<Value> {
        let address = email(body.get("identifier"))?;
        self.limit(&format!("challenge:{address}"), 5).await?;
        let mut tx = self.db.begin().await?;
        let account = sqlx::query(
            "SELECT id,email,verified FROM customer_accounts WHERE email=$1 AND disabled=false FOR UPDATE",
        )
        .bind(&address)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(account) = account {
            let verified: bool = account
                .try_get("verified")
                .map_err(|_| ApiError::unavailable())?;
            if purpose == "reset" || !verified {
                let account_id: Uuid =
                    account.try_get("id").map_err(|_| ApiError::unavailable())?;
                let account_email: String = account
                    .try_get("email")
                    .map_err(|_| ApiError::unavailable())?;
                self.challenge(&mut tx, account_id, &account_email, purpose)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(json!({"status":"CHECK_EMAIL"}))
    }

    pub async fn consume(&self, body: &Value, purpose: &str) -> ApiResult<Value> {
        let address = email(body.get("identifier"))?;
        let token = body
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ApiError::bad("INVALID_OR_EXPIRED_LINK"));
        }
        self.limit(&format!("consume:{address}"), 10).await?;
        let encoded = if purpose == "reset" {
            let pass = password(body.get("password"))?;
            Some(self.password_work(move || hash_password(&pass)).await?)
        } else {
            None
        };

        let mut tx = self.db.begin().await?;
        let account = sqlx::query(
            "SELECT id FROM customer_accounts WHERE email=$1 AND disabled=false FOR UPDATE",
        )
        .bind(&address)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(account) = account else {
            return Err(ApiError::bad("INVALID_OR_EXPIRED_LINK"));
        };
        let account_id: Uuid = account.try_get("id").map_err(|_| ApiError::unavailable())?;
        let challenge = sqlx::query(
            "DELETE FROM account_challenges WHERE account_id=$1 AND purpose=$2 AND token_hash=$3 \
             AND expires_at>clock_timestamp() RETURNING id",
        )
        .bind(account_id)
        .bind(purpose)
        .bind(digest(token))
        .fetch_optional(&mut *tx)
        .await?;
        if challenge.is_none() {
            return Err(ApiError::bad("INVALID_OR_EXPIRED_LINK"));
        }
        if purpose == "verify" {
            sqlx::query("UPDATE customer_accounts SET verified=true WHERE id=$1")
                .bind(account_id)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE customer_accounts SET password_hash=$2 WHERE id=$1")
                .bind(account_id)
                .bind(encoded.ok_or_else(ApiError::unavailable)?)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM customer_sessions WHERE account_id=$1")
                .bind(account_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,$2,$3)")
            .bind(account_id.to_string())
            .bind(format!("account.{purpose}"))
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(json!({"status":"OK"}))
    }

    pub async fn login(&self, body: &Value) -> ApiResult<Value> {
        let address = email(body.get("identifier"))?;
        let pass = password(body.get("password"))?;
        self.limit(&format!("login:{address}"), 10).await?;
        let account = sqlx::query(
            "SELECT id,org_id,email,password_hash,verified,disabled FROM customer_accounts WHERE email=$1",
        )
        .bind(&address)
        .fetch_optional(&self.db)
        .await?;
        let stored_hash = match &account {
            Some(row) => row
                .try_get::<String, _>("password_hash")
                .map_err(|_| ApiError::unavailable())?,
            None => self.dummy_hash.clone(),
        };
        let pass_for_verify = pass.clone();
        let valid = self
            .password_work(move || Ok(verify_password(&stored_hash, &pass_for_verify)))
            .await?;
        let Some(account) = account else {
            return Err(ApiError::unauthorized("INVALID_CREDENTIALS"));
        };
        let disabled: bool = account
            .try_get("disabled")
            .map_err(|_| ApiError::unavailable())?;
        if !valid || disabled {
            return Err(ApiError::unauthorized("INVALID_CREDENTIALS"));
        }
        let account_id: Uuid = account.try_get("id").map_err(|_| ApiError::unavailable())?;
        let previous_hash: String = account
            .try_get("password_hash")
            .map_err(|_| ApiError::unavailable())?;

        let mut tx = self.db.begin().await?;
        let current = sqlx::query(
            "SELECT id,org_id,email,password_hash,verified FROM customer_accounts WHERE id=$1 AND disabled=false FOR UPDATE",
        )
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(current) = current else {
            return Err(ApiError::unauthorized("INVALID_CREDENTIALS"));
        };
        let current_hash: String = current
            .try_get("password_hash")
            .map_err(|_| ApiError::unavailable())?;
        if current_hash != previous_hash {
            return Err(ApiError::unauthorized("INVALID_CREDENTIALS"));
        }
        let email_value: String = current
            .try_get("email")
            .map_err(|_| ApiError::unavailable())?;
        let org_id: Uuid = current
            .try_get("org_id")
            .map_err(|_| ApiError::unavailable())?;
        let verified: bool = current
            .try_get("verified")
            .map_err(|_| ApiError::unavailable())?;
        let token = random_hex(32);
        sqlx::query(
            "INSERT INTO customer_sessions(token_hash,account_id,expires_at) \
             VALUES($1,$2,clock_timestamp()+interval '8 hours')",
        )
        .bind(digest(&token))
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'account.login',$2)",
        )
        .bind(account_id.to_string())
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(json!({
            "sessionToken":token,
            "user":{"id":account_id,"email":email_value,"verified":verified,"orgId":org_id}
        }))
    }

    pub async fn session(&self, header: Option<&str>) -> ApiResult<(Value, Principal)> {
        let token = bearer(header);
        if !valid_token(token) {
            return Err(ApiError::unauthorized("UNAUTHENTICATED"));
        }
        let row = sqlx::query(
            "SELECT a.id,a.org_id,a.email,a.verified FROM customer_sessions s \
             JOIN customer_accounts a ON a.id=s.account_id \
             WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND a.disabled=false",
        )
        .bind(digest(token))
        .fetch_optional(&self.db)
        .await?;
        let Some(row) = row else {
            return Err(ApiError::unauthorized("UNAUTHENTICATED"));
        };
        let id: Uuid = row.try_get("id").map_err(|_| ApiError::unavailable())?;
        let org_id: Uuid = row.try_get("org_id").map_err(|_| ApiError::unavailable())?;
        let email_value: String = row.try_get("email").map_err(|_| ApiError::unavailable())?;
        let verified: bool = row
            .try_get("verified")
            .map_err(|_| ApiError::unavailable())?;
        let user = json!({"id":id,"email":email_value,"verified":verified,"orgId":org_id});
        let mut principal = Principal::customer(id.to_string(), org_id.to_string());
        principal.email_verified = Some(verified);
        Ok((user, principal))
    }

    pub async fn logout(&self, header: Option<&str>) -> ApiResult<Value> {
        let token = bearer(header);
        sqlx::query("DELETE FROM customer_sessions WHERE token_hash=$1")
            .bind(digest(token))
            .execute(&self.db)
            .await?;
        Ok(json!({"status":"OK"}))
    }
}

pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn bearer(header: Option<&str>) -> &str {
    header
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("")
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn email(value: Option<&Value>) -> ApiResult<String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Err(ApiError::bad("INVALID_EMAIL"));
    };
    let trimmed = value.trim();
    let mut parts = trimmed.split('@');
    let local = parts.next().unwrap_or_default();
    let host = parts.next().unwrap_or_default();
    let valid = parts.next().is_none()
        && !local.is_empty()
        && !host.is_empty()
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !trimmed.chars().any(char::is_whitespace)
        && trimmed.len() <= 254;
    if !valid {
        return Err(ApiError::bad("INVALID_EMAIL"));
    }
    Ok(trimmed.to_lowercase())
}

fn password(value: Option<&Value>) -> ApiResult<String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Err(ApiError::bad("PASSWORD_LENGTH"));
    };
    if !(12..=128).contains(&value.len()) {
        return Err(ApiError::bad("PASSWORD_LENGTH"));
    }
    Ok(value.to_owned())
}

fn hash_password(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::unavailable())
}

fn verify_password(encoded: &str, password: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

fn random_hex(length: usize) -> String {
    let mut bytes = vec![0u8; length];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
