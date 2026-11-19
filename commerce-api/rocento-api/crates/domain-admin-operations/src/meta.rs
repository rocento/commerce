//! Merchant-local Meta settings, write-only secrets and durable consent receipts.
use infra_auth::{secrets::Vault, Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub api_version: String,
    pub whatsapp_enabled: bool,
    pub waba_id: String,
    pub phone_number_id: String,
    pub confirmation_template: String,
    pub template_language: String,
    pub catalog_enabled: bool,
    pub catalog_id: String,
    pub conversions_enabled: bool,
    pub dataset_id: String,
    pub test_event_code: String,
}
pub const SECRET_NAMES: &[&str] = &[
    "whatsapp_token",
    "catalog_token",
    "conversions_token",
    "app_secret",
    "webhook_verify_token",
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i64,
    pub config: Config,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    #[serde(default)]
    pub clear_secrets: Vec<String>,
}
#[derive(Serialize)]
pub struct Status {
    pub revision: i64,
    pub config: Config,
    pub configured_secrets: Vec<String>,
    pub editable: bool,
    pub last_webhook_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_feed_at: Option<chrono::DateTime<chrono::Utc>>,
}
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub vault: Option<Vault>,
}
impl Config {
    pub fn validate(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        let valid_version = self
            .api_version
            .strip_prefix('v')
            .and_then(|s| s.strip_suffix(".0"))
            .is_some_and(|s| {
                !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit())
            });
        if !valid_version {
            return Err(Error::Invalid(
                "Enter a Graph API version such as v23.0".into(),
            ));
        }
        for id in [
            &self.waba_id,
            &self.phone_number_id,
            &self.catalog_id,
            &self.dataset_id,
        ] {
            if id.len() > 64 || !id.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Error::Invalid(
                    "Meta asset IDs must contain only digits".into(),
                ));
            }
        }
        for value in [
            &self.confirmation_template,
            &self.template_language,
            &self.test_event_code,
        ] {
            if value.len() > 100
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(Error::Invalid(
                    "Invalid template, language or test event code".into(),
                ));
            }
        }
        let required = [
            (
                self.whatsapp_enabled,
                vec![
                    self.waba_id.as_str(),
                    self.phone_number_id.as_str(),
                    self.confirmation_template.as_str(),
                    self.template_language.as_str(),
                ],
                vec!["whatsapp_token", "app_secret", "webhook_verify_token"],
            ),
            (
                self.catalog_enabled,
                vec![self.catalog_id.as_str()],
                vec!["catalog_token"],
            ),
            (
                self.conversions_enabled,
                vec![self.dataset_id.as_str()],
                vec!["conversions_token"],
            ),
        ];
        for (enabled, ids, keys) in required {
            if enabled
                && (ids.iter().any(|s| s.is_empty())
                    || keys.iter().any(|k| !secrets.contains_key(*k)))
            {
                return Err(Error::Invalid(
                    "Complete the asset IDs and credentials before enabling this service".into(),
                ));
            }
        }
        Ok(())
    }
}
impl Service {
    pub async fn context(&self) -> Result<String> {
        let id: Uuid =
            sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
                .fetch_one(&self.pool)
                .await?;
        Ok(format!("meta:{id}"))
    }
    pub async fn seal(&self, value: &[u8]) -> Result<Vec<u8>> {
        self.vault
            .as_ref()
            .ok_or(Error::Invalid(
                "Meta credential storage is not configured on this server".into(),
            ))?
            .seal(&self.context().await?, value)
    }
    pub async fn open(&self, value: &[u8]) -> Result<Vec<u8>> {
        self.vault
            .as_ref()
            .ok_or(Error::Internal)?
            .open(&self.context().await?, value)
    }
    pub async fn credentials(&self) -> Result<BTreeMap<String, String>> {
        let bytes: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT credentials FROM platform.meta_settings WHERE singleton")
                .fetch_one(&self.pool)
                .await?;
        match bytes {
            Some(b) => serde_json::from_slice(&self.open(&b).await?).map_err(|_| Error::Internal),
            None => Ok(BTreeMap::new()),
        }
    }
    pub async fn status(&self) -> Result<Status> {
        let (revision, config, last_webhook_at, last_feed_at): (i64,serde_json::Value,Option<chrono::DateTime<chrono::Utc>>,Option<chrono::DateTime<chrono::Utc>>)=sqlx::query_as("SELECT revision,config,last_webhook_at,last_feed_at FROM platform.meta_settings WHERE singleton").fetch_one(&self.pool).await?;
        // Never expose ciphertext, provider responses or a credential suffix.
        Ok(Status {
            revision,
            config: serde_json::from_value(config).map_err(|_| Error::Internal)?,
            configured_secrets: if self.vault.is_some() {
                self.credentials().await?.into_keys().collect()
            } else {
                vec![]
            },
            editable: self.vault.is_some(),
            last_webhook_at,
            last_feed_at,
        })
    }
    pub async fn save(&self, actor: Uuid, input: Input) -> Result<Status> {
        let mut tx = self.pool.begin().await?;
        let revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM platform.meta_settings WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await?;
        if revision != input.expected_revision {
            return Err(Error::Conflict);
        }
        let mut secrets = self.credentials().await?;
        for name in &input.clear_secrets {
            if !SECRET_NAMES.contains(&name.as_str()) {
                return Err(Error::Invalid("Unknown credential field".into()));
            }
            secrets.remove(name);
        }
        for (name, value) in input.secrets {
            if !SECRET_NAMES.contains(&name.as_str())
                || value.len() > 4096
                || !value.bytes().all(|b| b.is_ascii_graphic())
                || (!value.is_empty() && input.clear_secrets.contains(&name))
            {
                return Err(Error::Invalid("Invalid credential field".into()));
            }
            if !value.is_empty() {
                secrets.insert(name, value);
            }
        }
        input.config.validate(&secrets)?;
        let encrypted = self
            .seal(&serde_json::to_vec(&secrets).map_err(|_| Error::Internal)?)
            .await?;
        sqlx::query("UPDATE platform.meta_settings SET revision=revision+1,config=$1,credentials=$2,updated_at=now() WHERE singleton").bind(serde_json::to_value(input.config).map_err(|_|Error::Internal)?).bind(encrypted).execute(&mut *tx).await?;
        // Configuration changes must not redirect queued customer data to a different business.
        sqlx::query("UPDATE platform.meta_jobs SET status='cancelled',error_code='configuration_changed',payload=''::bytea,completed_at=now() WHERE status='pending'").execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(actor),
            "integrations.meta.updated",
            Uuid::nil(),
            serde_json::json!({"revision":revision+1}),
        )
        .await?;
        tx.commit().await?;
        self.status().await
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Consent {
    pub conversions: bool,
    pub whatsapp: bool,
    pub phone: String,
}
#[derive(sqlx::FromRow)]
struct ConsentPreflight {
    placed: bool,
    revision: Option<i64>,
    config: Option<serde_json::Value>,
    owns_quote: bool,
    installation_id: Option<Uuid>,
}
impl Service {
    pub async fn record_consent(
        &self,
        customer: Uuid,
        quote: Uuid,
        consent: Consent,
    ) -> Result<()> {
        let mut connection = self.pool.acquire().await?;
        self.record_consent_on(&mut connection, customer, quote, consent)
            .await
    }
    /// The checkout caller supplies an autocommit connection so this receipt
    /// remains durable even if the later order transaction fails.
    pub async fn record_consent_on(
        &self,
        connection: &mut sqlx::PgConnection,
        customer: Uuid,
        quote: Uuid,
        consent: Consent,
    ) -> Result<()> {
        // Optional fields stay undecoded until the committed-order bypass and
        // the original validation order. No nested acquisition is needed.
        let preflight: ConsentPreflight = sqlx::query_as(
            "SELECT EXISTS(SELECT 1 FROM orders.orders WHERE quote_id=$1 AND customer_id=$2) AS placed,m.revision,m.config,EXISTS(SELECT 1 FROM cart_checkout.quotes WHERE id=$1 AND customer_id=$2) AS owns_quote,p.installation_id FROM (SELECT 1) anchor LEFT JOIN platform.meta_settings m ON m.singleton LEFT JOIN platform.publication_installation p ON p.singleton AND $3",
        )
        .bind(quote)
        .bind(customer)
        .bind(consent.whatsapp)
        .fetch_one(&mut *connection)
        .await?;
        if preflight.placed {
            return Ok(());
        }
        // Ordinary checkout must not depend on decrypting optional provider credentials.
        let revision = preflight.revision.ok_or(sqlx::Error::RowNotFound)?;
        let raw = preflight.config.ok_or(sqlx::Error::RowNotFound)?;
        let config: Config = serde_json::from_value(raw).map_err(|_| Error::Internal)?;
        if ((consent.conversions || consent.whatsapp) && self.vault.is_none())
            || (consent.conversions && !config.conversions_enabled)
            || (consent.whatsapp && !config.whatsapp_enabled)
        {
            return Err(Error::Invalid(
                "The selected Meta service is unavailable".into(),
            ));
        }
        if consent.whatsapp
            && (!consent.phone.starts_with('+')
                || !(9..=16).contains(&consent.phone.len())
                || consent.phone.as_bytes()[1] == b'0'
                || !consent.phone[1..].bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(Error::Invalid(
                "Enter a WhatsApp phone number with country code".into(),
            ));
        }
        let phone = if consent.whatsapp {
            let installation = preflight.installation_id.ok_or(sqlx::Error::RowNotFound)?;
            // self.seal() obtains its context through the pool; doing that while
            // holding this connection would deadlock a one-connection pool.
            Some(
                self.vault
                    .as_ref()
                    .ok_or(Error::Internal)?
                    .seal(&format!("meta:{installation}"), consent.phone.as_bytes())?,
            )
        } else {
            None
        };
        if !preflight.owns_quote {
            return Err(Error::NotFound);
        }
        sqlx::query("INSERT INTO platform.meta_checkout_consent(quote_id,customer_id,conversions,whatsapp,phone_ciphertext,settings_revision) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS(SELECT 1 FROM orders.orders WHERE quote_id=$1) ON CONFLICT(quote_id) DO UPDATE SET conversions=platform.meta_checkout_consent.conversions AND excluded.conversions,whatsapp=platform.meta_checkout_consent.whatsapp AND excluded.whatsapp WHERE platform.meta_checkout_consent.processed_at IS NULL AND NOT EXISTS(SELECT 1 FROM orders.orders WHERE quote_id=$1)").bind(quote).bind(customer).bind(consent.conversions).bind(consent.whatsapp).bind(phone).bind(revision).execute(&mut *connection).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enabling_requires_its_own_assets_and_secrets() {
        let mut c = Config {
            api_version: "v23.0".into(),
            ..Default::default()
        };
        assert!(c.validate(&BTreeMap::new()).is_ok());
        c.whatsapp_enabled = true;
        assert!(c.validate(&BTreeMap::new()).is_err());
        c.whatsapp_enabled = false;
        c.conversions_enabled = true;
        c.dataset_id = "123".into();
        assert!(c
            .validate(
                &[("whatsapp_token".into(), "not-a-conversions-token".into())]
                    .into_iter()
                    .collect()
            )
            .is_err());
        assert!(c
            .validate(
                &[("conversions_token".into(), "secret".into())]
                    .into_iter()
                    .collect()
            )
            .is_ok());
    }
    #[test]
    fn api_paths_cannot_be_injected_through_asset_ids_or_versions() {
        for bad in [
            "v23.0/other",
            "https://attacker.test",
            "v23.0?access_token=x",
        ] {
            assert!(Config {
                api_version: bad.into(),
                ..Default::default()
            }
            .validate(&BTreeMap::new())
            .is_err());
        }
        assert!(Config {
            api_version: "v23.0".into(),
            catalog_id: "123/messages".into(),
            ..Default::default()
        }
        .validate(&BTreeMap::new())
        .is_err());
    }
}
