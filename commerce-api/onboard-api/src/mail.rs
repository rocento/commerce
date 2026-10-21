use std::{env, path::PathBuf, time::Duration};

use lettre::{
    message::Mailbox, transport::smtp::authentication::Credentials, AsyncSmtpTransport,
    AsyncTransport, Message, Tokio1Executor,
};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use url::Url;
use uuid::Uuid;

use crate::{
    accounts::SecretBox,
    error::{ApiError, ApiResult},
};

#[derive(Clone)]
pub struct Mailer {
    sender: Sender,
    origin: Url,
}

#[derive(Clone)]
enum Sender {
    File(PathBuf),
    Smtp {
        client: AsyncSmtpTransport<Tokio1Executor>,
        from: Mailbox,
    },
}

#[derive(Debug, Deserialize)]
struct Delivery {
    email: String,
    token: String,
    purpose: String,
}

impl Mailer {
    pub fn from_env(production: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let origin = Url::parse(
            &env::var("CUSTOMER_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:3100".to_owned()),
        )?;
        if origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("CUSTOMER_ORIGIN must be an origin".into());
        }
        let mode = env::var("AUTH_MAIL_MODE").unwrap_or_default();
        if production && (mode != "smtp" || origin.scheme() != "https") {
            return Err("Production requires SMTP and HTTPS".into());
        }
        let sender = match mode.as_str() {
            "file" if !production => Sender::File(PathBuf::from(
                env::var("LOCAL_MAIL_DIR").unwrap_or_else(|_| ".local/mail".to_owned()),
            )),
            "file" => return Err("Local mail is disabled in production".into()),
            "smtp" => {
                let host = env::var("SMTP_HOST")?;
                let port = env::var("SMTP_PORT").unwrap_or_else(|_| "587".to_owned());
                let from: Mailbox = env::var("MAIL_FROM")?.parse()?;
                let builder = match port.as_str() {
                    "465" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host)?,
                    "587" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)?,
                    _ => return Err("SMTP_PORT must be 465 or 587".into()),
                };
                let builder = if let Ok(username) = env::var("SMTP_USER") {
                    let password = env::var("SMTP_PASSWORD")?;
                    builder.credentials(Credentials::new(username, password))
                } else {
                    builder
                };
                Sender::Smtp {
                    client: builder.timeout(Some(Duration::from_secs(10))).build(),
                    from,
                }
            }
            _ => return Err("Configure AUTH_MAIL_MODE=file locally or smtp".into()),
        };
        Ok(Self { sender, origin })
    }

    async fn send(
        &self,
        id: Uuid,
        delivery: Delivery,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut link = self.origin.join("account")?;
        let fragment = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("purpose", &delivery.purpose)
            .append_pair("identifier", &delivery.email)
            .append_pair("token", &delivery.token)
            .finish();
        link.set_fragment(Some(&fragment));
        let (subject, action) = if delivery.purpose == "verify" {
            ("Verify your Rocento account", "Verify your email")
        } else {
            ("Reset your Rocento password", "Reset your password")
        };
        let text = format!(
            "{action}: {link}\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this email."
        );
        match &self.sender {
            Sender::File(directory) => {
                tokio::fs::create_dir_all(directory).await?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    tokio::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                        .await?;
                }
                let file = directory.join(format!("{id}.json"));
                let payload =
                    serde_json::json!({"to":delivery.email,"subject":subject,"text":text});
                tokio::fs::write(file, serde_json::to_vec_pretty(&payload)?).await?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    tokio::fs::set_permissions(
                        directory.join(format!("{id}.json")),
                        std::fs::Permissions::from_mode(0o600),
                    )
                    .await?;
                }
                Ok(())
            }
            Sender::Smtp { client, from } => {
                let message = Message::builder()
                    .from(from.clone())
                    .to(delivery.email.parse()?)
                    .subject(subject)
                    .message_id(Some(format!("<{id}@onboarding.rocento.com")))
                    .body(text)?;
                client.send(message).await?;
                Ok(())
            }
        }
    }
}

pub async fn deliver_one(db: &PgPool, box_: &SecretBox, mailer: &Mailer) -> ApiResult<bool> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT d.id,d.encrypted_payload FROM auth_deliveries d \
         JOIN account_challenges c ON c.id=d.id \
         WHERE d.delivered_at IS NULL AND d.attempts<5 AND d.available_at<=clock_timestamp() \
         AND c.expires_at>clock_timestamp() FOR UPDATE OF d SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(false);
    };
    let id: Uuid = row.try_get("id").map_err(|_| ApiError::unavailable())?;
    let encrypted: Option<String> = row
        .try_get("encrypted_payload")
        .map_err(|_| ApiError::unavailable())?;
    let result = encrypted
        .as_deref()
        .ok_or_else(ApiError::unavailable)
        .and_then(|payload| box_.open(payload))
        .and_then(|payload| {
            serde_json::from_value::<Delivery>(payload).map_err(|_| ApiError::unavailable())
        });
    let delivered = match result {
        Ok(delivery) => mailer.send(id, delivery).await.is_ok(),
        Err(_) => false,
    };
    if delivered {
        sqlx::query("UPDATE auth_deliveries SET delivered_at=clock_timestamp(),encrypted_payload=NULL WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
    } else {
        sqlx::query(
                "UPDATE auth_deliveries SET attempts=attempts+1,available_at=clock_timestamp()+interval '30 seconds' WHERE id=$1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(true)
}
