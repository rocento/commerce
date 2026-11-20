//! Installation-owned Google connections. Credentials are write-only and authenticated
//! against both installation and service; callers cannot select another tenant.
use infra_auth::{secrets::Vault, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

pub const SERVICES: &[&str] = &["merchant", "ga4", "maps"];
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub account_id: String,
    pub data_source_id: String,
    pub language: String,
    pub feed_label: String,
    pub measurement_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i64,
    pub enabled: bool,
    pub config: Config,
    pub credential: Option<String>,
    #[serde(default)]
    pub clear_credential: bool,
}
#[derive(Serialize, FromRow)]
pub struct Status {
    pub service: String,
    pub revision: i64,
    pub enabled: bool,
    pub config: Value,
    pub credential_configured: bool,
    pub checked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub check_code: Option<String>,
    pub last_sync_at: Option<chrono::DateTime<chrono::Utc>>,
    pub sync_code: Option<String>,
    pub sync_scanned: i64,
    pub sync_submitted: i64,
    pub sync_excluded: i64,
    pub sync_rejected: i64,
    #[sqlx(skip)]
    pub editable: bool,
}
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub vault: Option<Vault>,
}
pub fn validate(service: &str, input: &Input, has_credential: bool) -> Result<()> {
    if !SERVICES.contains(&service) {
        return Err(Error::NotFound);
    }
    if input.expected_revision < 1 {
        return Err(Error::Invalid("Invalid revision".into()));
    }
    let c = &input.config;
    let digits = |s: &str| s.len() <= 30 && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(&c.account_id)
        || !digits(&c.data_source_id)
        || (!c.language.is_empty()
            && (c.language.len() != 2 || !c.language.bytes().all(|b| b.is_ascii_lowercase())))
        || c.feed_label.len() > 20
        || !c
            .feed_label
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        || (!c.measurement_id.is_empty()
            && (!c.measurement_id.starts_with("G-")
                || !(5..=32).contains(&c.measurement_id.len())
                || !c.measurement_id[2..]
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())))
    {
        return Err(Error::Invalid(
            "Check the Google account IDs, language, feed label and measurement ID".into(),
        ));
    }
    if service != "merchant"
        && (!c.account_id.is_empty()
            || !c.data_source_id.is_empty()
            || !c.language.is_empty()
            || !c.feed_label.is_empty())
        || service != "ga4" && !c.measurement_id.is_empty()
    {
        return Err(Error::Invalid(
            "Configuration fields belong to a different service".into(),
        ));
    }
    if let Some(secret) = input.credential.as_ref().filter(|s| !s.is_empty()) {
        if input.clear_credential || secret.len() > 16384 {
            return Err(Error::Invalid("Invalid credential".into()));
        }
        match service {
            "merchant" => {
                let v: Value = serde_json::from_str(secret).map_err(|_| {
                    Error::Invalid("Enter a Google service account JSON key".into())
                })?;
                if v["type"] != "service_account"
                    || !v["client_email"]
                        .as_str()
                        .is_some_and(|s| s.len() < 254 && s.ends_with(".iam.gserviceaccount.com"))
                    || !v["private_key"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("-----BEGIN PRIVATE KEY-----"))
                {
                    return Err(Error::Invalid(
                        "Enter a Google service account JSON key".into(),
                    ));
                }
            }
            "maps"
                if secret.len() <= 256
                    && secret
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) => {}
            _ => return Err(Error::Invalid("Invalid credential for this service".into())),
        }
    }
    if input.enabled
        && match service {
            "merchant" => {
                !has_credential
                    || [&c.account_id, &c.data_source_id, &c.language, &c.feed_label]
                        .iter()
                        .any(|s| s.is_empty())
            }
            "ga4" => c.measurement_id.is_empty(),
            "maps" => !has_credential,
            _ => true,
        }
    {
        return Err(Error::Invalid(
            "Complete this service's settings and credentials before enabling it".into(),
        ));
    }
    Ok(())
}
impl Service {
    pub async fn context(&self, service: &str) -> Result<String> {
        let id: Uuid =
            sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
                .fetch_one(&self.pool)
                .await?;
        Ok(format!("google:{id}:{service}"))
    }
    pub async fn decode(&self, service: &str, ciphertext: &[u8]) -> Result<String> {
        let data = self
            .vault
            .as_ref()
            .ok_or(Error::Busy)?
            .open(&self.context(service).await?, ciphertext)?;
        String::from_utf8(data).map_err(|_| Error::Internal)
    }
    pub async fn list(&self) -> Result<Vec<Status>> {
        let mut rows:Vec<Status>=sqlx::query_as("SELECT service,revision,enabled,config,credentials IS NOT NULL credential_configured,checked_at,check_code,last_sync_at,sync_code,sync_scanned,sync_submitted,sync_excluded,sync_rejected FROM platform.google_connections ORDER BY service").fetch_all(&self.pool).await?;
        for r in &mut rows {
            r.editable = r.service == "ga4" || self.vault.is_some();
        }
        Ok(rows)
    }
    pub async fn save(&self, actor: Uuid, service: &str, input: Input) -> Result<Vec<Status>> {
        if !SERVICES.contains(&service) {
            return Err(Error::NotFound);
        }
        let mut tx = self.pool.begin().await?;
        let (revision,old,old_config):(i64,Option<Vec<u8>>,Value)=sqlx::query_as("SELECT revision,credentials,config FROM platform.google_connections WHERE service=$1 FOR UPDATE").bind(service).fetch_one(&mut *tx).await?;
        if revision != input.expected_revision {
            return Err(Error::Conflict);
        }
        let new_secret = input.credential.as_ref().filter(|s| !s.is_empty());
        validate(
            service,
            &input,
            new_secret.is_some() || (old.is_some() && !input.clear_credential),
        )?;
        // Changing a feed's destination while products are tracked would strand remote offers.
        if service == "merchant" {
            let previous: Config =
                serde_json::from_value(old_config).map_err(|_| Error::Internal)?;
            if previous.account_id != input.config.account_id
                || previous.data_source_id != input.config.data_source_id
                || previous.language != input.config.language
                || previous.feed_label != input.config.feed_label
            {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.google_products)")
                        .fetch_one(&mut *tx)
                        .await?;
                if exists {
                    return Err(Error::Invalid("Disconnect Merchant Center before changing its feed destination. Remove the old data source in Merchant Center to remove previously submitted products.".into()));
                }
            }
        }
        let encrypted = if let Some(secret) = new_secret {
            Some(
                self.vault
                    .as_ref()
                    .ok_or(Error::Invalid(
                        "Google credential storage is not configured on this server".into(),
                    ))?
                    .seal(&self.context(service).await?, secret.as_bytes())?,
            )
        } else if input.clear_credential {
            None
        } else {
            old
        };
        sqlx::query("UPDATE platform.google_connections SET revision=revision+1,enabled=$2,config=$3,credentials=$4,checked_at=NULL,check_code=NULL,next_sync_at=now(),sync_cursor='00000000-0000-0000-0000-000000000000',sync_code=NULL,updated_at=now() WHERE service=$1").bind(service).bind(input.enabled).bind(serde_json::to_value(input.config).map_err(|_|Error::Internal)?).bind(encrypted).execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(actor),
            "integrations.google.updated",
            Uuid::nil(),
            json!({"service":service,"revision":revision+1}),
        )
        .await?;
        tx.commit().await?;
        self.list().await
    }
    pub async fn disconnect(
        &self,
        actor: Uuid,
        service: &str,
        revision: i64,
    ) -> Result<Vec<Status>> {
        if !SERVICES.contains(&service) {
            return Err(Error::NotFound);
        }
        let mut tx = self.pool.begin().await?;
        let changed=sqlx::query("UPDATE platform.google_connections SET enabled=false,credentials=NULL,revision=revision+1,checked_at=NULL,check_code=NULL,sync_code=NULL,updated_at=now() WHERE service=$1 AND revision=$2").bind(service).bind(revision).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(Error::Conflict);
        }
        if service == "merchant" {
            sqlx::query("DELETE FROM platform.google_products")
                .execute(&mut *tx)
                .await?;
        }
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(actor),
            "integrations.google.disconnected",
            Uuid::nil(),
            json!({"service":service}),
        )
        .await?;
        tx.commit().await?;
        self.list().await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input {
        Input {
            expected_revision: 1,
            enabled: true,
            config: Config::default(),
            credential: None,
            clear_credential: false,
        }
    }
    #[test]
    fn requires_service_specific_configuration() {
        assert!(validate("maps", &input(), false).is_err());
        assert!(validate("maps", &input(), true).is_ok());
        assert!(validate("ga4", &input(), true).is_err());
        let mut i = input();
        i.config.measurement_id = "G-ABC123".into();
        assert!(validate("ga4", &i, false).is_ok());
        assert!(validate("maps", &i, true).is_err());
        i.config.measurement_id = "G-<script>".into();
        assert!(validate("ga4", &i, false).is_err());
    }
    #[test]
    fn invalid_secret_is_not_echoed() {
        let mut i = input();
        i.credential = Some("secret-canary".into());
        assert!(!validate("merchant", &i, true)
            .unwrap_err()
            .to_string()
            .contains("canary"));
        i.clear_credential = true;
        assert!(validate("maps", &i, true).is_err());
    }
}
