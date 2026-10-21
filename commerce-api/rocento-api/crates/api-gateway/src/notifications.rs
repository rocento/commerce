//! Bounded at-least-once delivery through test inboxes or authenticated TLS SMTP.
use crate::email_templates::{render_builtin_notification, render_notification_in, RenderedEmail};
use infra_auth::{Notification, NotificationSink};
use sqlx::{FromRow, PgPool};
use std::{future::Future, pin::Pin, time::Duration};
use uuid::Uuid;

pub type Delivery<'a> = Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send + 'a>>;
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, id: Uuid, notification: &'a Notification) -> Delivery<'a>;

    /// Delivery workers provide the persisted rendering so retries use identical content.
    fn send_rendered<'a>(
        &'a self,
        id: Uuid,
        notification: &'a Notification,
        _email: &'a RenderedEmail,
    ) -> Delivery<'a> {
        self.send(id, notification)
    }
}

pub fn validate_mode(environment: &str, mode: &str) -> Result<(), &'static str> {
    match (environment, mode) {
        (_, "smtp") | ("development", "console" | "mailpit") => Ok(()),
        _ => Err("Production requires NOTIFICATION_MODE=smtp; console/mailpit require APP_ENV=development"),
    }
}

/// Enqueue inside the event receipt transaction, using its stable event ID.
/// Only the explicitly local console adapter bypasses durable delivery.
pub async fn enqueue_commerce(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    mode: &str,
    event_id: Uuid,
    customer_id: Uuid,
    notification: &Notification,
) -> infra_auth::Result<bool> {
    if !matches!(notification.purpose.as_str(), "order" | "shipment") {
        return Err(infra_auth::Error::Invalid(
            "Invalid commerce notification purpose".into(),
        ));
    }
    match mode {
        "smtp" | "mailpit" => {
            infra_auth::notifications::enqueue(
                tx,
                event_id,
                Some(customer_id),
                None,
                notification,
                86400,
            )
            .await?;
            Ok(true)
        }
        "console" => Ok(false),
        _ => Err(infra_auth::Error::Invalid(
            "Invalid notification delivery mode".into(),
        )),
    }
}

pub struct Smtp {
    client: lettre::AsyncSmtpTransport<lettre::Tokio1Executor>,
    sender: lettre::message::Mailbox,
    origin: reqwest::Url,
}

impl Smtp {
    pub fn from_env() -> Result<Self, &'static str> {
        let required = |key| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or("Missing SMTP configuration")
        };
        Self::new(
            &required("SMTP_HOST")?,
            &required("SMTP_PORT")?,
            &required("SMTP_USERNAME")?,
            required("SMTP_PASSWORD")?,
            &required("NOTIFICATION_FROM")?,
            &required("STOREFRONT_URL")?,
        )
    }

    pub fn new(
        host: &str,
        port: &str,
        username: &str,
        password: String,
        sender: &str,
        storefront: &str,
    ) -> Result<Self, &'static str> {
        use lettre::{
            transport::smtp::authentication::Credentials, AsyncSmtpTransport, Tokio1Executor,
        };
        if host.is_empty() || username.is_empty() || password.is_empty() {
            return Err("Missing SMTP credentials or host");
        }
        let origin = reqwest::Url::parse(storefront).map_err(|_| "Invalid storefront URL")?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("SMTP requires an HTTPS storefront URL");
        }
        let builder = match port {
            "465" => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
            "587" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
            _ => return Err("SMTP_PORT must be 465 (TLS) or 587 (required STARTTLS)"),
        }
        .map_err(|_| "Invalid SMTP TLS configuration")?;
        Ok(Self {
            client: builder
                .credentials(Credentials::new(username.into(), password))
                .timeout(Some(Duration::from_secs(10)))
                .build(),
            sender: sender.parse().map_err(|_| "Invalid notification sender")?,
            origin,
        })
    }

    #[cfg(test)]
    fn message(&self, id: Uuid, n: &Notification) -> Result<lettre::Message, &'static str> {
        validate_notification(n, &self.origin)?;
        let email = render_builtin_notification(n).map_err(|_| "invalid_message")?;
        self.message_with_email(id, n, &email)
    }

    fn message_with_email(
        &self,
        id: Uuid,
        n: &Notification,
        email: &RenderedEmail,
    ) -> Result<lettre::Message, &'static str> {
        use lettre::message::{MultiPart, SinglePart};
        validate_notification(n, &self.origin)?;
        validate_rendered_email(email)?;
        lettre::Message::builder()
            .from(self.sender.clone())
            .to(n.identifier.parse().map_err(|_| "invalid_recipient")?)
            .subject(&email.subject)
            .message_id(Some(format!("<{id}@{}>", self.sender.email.domain())))
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(email.text.clone()))
                    .singlepart(SinglePart::html(email.html.clone())),
            )
            .map_err(|_| "invalid_message")
    }
}

/// Authentication links are checked independently of editable or persisted templates.
fn validate_notification(n: &Notification, origin: &reqwest::Url) -> Result<(), &'static str> {
    if n.mobile {
        return Err("sms_not_configured");
    }
    match n.purpose.as_str() {
        "verify" | "reset" => {
            let link = reqwest::Url::parse(&n.link).map_err(|_| "invalid_verification_link")?;
            if link.origin() != origin.origin()
                || !link.username().is_empty()
                || link.password().is_some()
            {
                return Err("invalid_verification_link");
            }
        }
        "order" | "shipment" => {
            if n.link.len() > 2048
                || n.link.trim().is_empty()
                || n.link
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
            {
                return Err("invalid_message");
            }
        }
        "demo_login" if crate::login_alerts::validate(n) => {}
        _ => return Err("unsupported_purpose"),
    }
    Ok(())
}

fn validate_rendered_email(email: &RenderedEmail) -> Result<(), &'static str> {
    if email.subject.trim().is_empty()
        || email.subject.len() > 998
        || email.subject.chars().any(char::is_control)
        || email.text.trim().is_empty()
        || email.text.len() > 128 * 1024
        || email.html.trim().is_empty()
        || email.html.len() > 256 * 1024
    {
        return Err("invalid_message");
    }
    Ok(())
}

impl Transport for Smtp {
    fn send<'a>(&'a self, id: Uuid, n: &'a Notification) -> Delivery<'a> {
        Box::pin(async move {
            validate_notification(n, &self.origin)?;
            let email = render_builtin_notification(n).map_err(|_| "invalid_message")?;
            self.send_rendered(id, n, &email).await
        })
    }

    fn send_rendered<'a>(
        &'a self,
        id: Uuid,
        n: &'a Notification,
        email: &'a RenderedEmail,
    ) -> Delivery<'a> {
        Box::pin(async move {
            use lettre::AsyncTransport;
            let message = self.message_with_email(id, n, email)?;
            self.client.send(message).await.map(|_| ()).map_err(|e| {
                if e.is_permanent() {
                    "provider_rejected_permanent"
                } else {
                    "provider_unavailable"
                }
            })
        })
    }
}

pub struct Mailpit {
    client: reqwest::Client,
    endpoint: String,
    sender: String,
    origin: reqwest::Url,
}
impl Mailpit {
    pub fn new(base: &str, sender: &str) -> Result<Self, &'static str> {
        Self::new_with_storefront(base, sender, "http://localhost:5173")
    }

    pub fn new_with_storefront(
        base: &str,
        sender: &str,
        storefront: &str,
    ) -> Result<Self, &'static str> {
        let origin = reqwest::Url::parse(storefront).map_err(|_| "Invalid storefront URL")?;
        if !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("Invalid storefront URL");
        }
        let url = reqwest::Url::parse(base).map_err(|_| "Invalid Mailpit URL")?;
        if url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("mailpit" | "localhost" | "127.0.0.1" | "[::1]")
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Mailpit must be a local HTTP inbox URL");
        }
        if infra_auth::identifier(sender).map(|(_, kind)| kind).ok() != Some("email") {
            return Err("Invalid notification sender");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "HTTP client unavailable")?,
            endpoint: format!("{}/api/v1/send", base.trim_end_matches('/')),
            sender: sender.into(),
            origin,
        })
    }
}
impl Transport for Mailpit {
    fn send<'a>(&'a self, id: Uuid, n: &'a Notification) -> Delivery<'a> {
        Box::pin(async move {
            if n.mobile {
                // SMS still uses the explicitly local console adapter.
                infra_auth::ConsoleNotifications.send(n.clone());
                return Ok(());
            }
            validate_notification(n, &self.origin)?;
            let email = render_builtin_notification(n).map_err(|_| "invalid_message")?;
            self.send_rendered(id, n, &email).await
        })
    }

    fn send_rendered<'a>(
        &'a self,
        id: Uuid,
        n: &'a Notification,
        email: &'a RenderedEmail,
    ) -> Delivery<'a> {
        Box::pin(async move {
            validate_notification(n, &self.origin)?;
            validate_rendered_email(email)?;
            if infra_auth::identifier(&n.identifier)
                .map(|(_, kind)| kind)
                .ok()
                != Some("email")
            {
                return Err("invalid_recipient");
            }
            let response = self
                .client
                .post(&self.endpoint)
                .json(&serde_json::json!({
                    "From":{"Email":self.sender,"Name":"Rocento test store"},
                    "To":[{"Email":n.identifier}],
                    "Subject":email.subject,"Text":email.text,"HTML":email.html,
                    "Headers":{"Message-ID":format!("<{id}@commerce.test>")}
                }))
                .send()
                .await
                .map_err(|_| "provider_unavailable")?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err("provider_rejected")
            }
        })
    }
}

#[derive(FromRow)]
struct Job {
    id: Uuid,
    payload: serde_json::Value,
    attempts: i32,
}

/// One locked job per transaction. Rollback releases it after a worker crash.
pub async fn deliver_one(pool: &PgPool, transport: &dyn Transport) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE platform.notification_jobs j SET status='expired',payload=NULL,completed_at=clock_timestamp() WHERE status='pending' AND (expires_at<=clock_timestamp() OR (challenge_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customers.challenges c WHERE c.customer_id=j.customer_id AND c.purpose=j.purpose AND c.token_hash=j.challenge_hash AND c.expires_at>clock_timestamp())))")
        .execute(&mut *tx).await?;
    let job: Option<Job> = sqlx::query_as("SELECT id,payload,attempts FROM platform.notification_jobs WHERE status='pending' AND available_at<=clock_timestamp() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1")
        .fetch_optional(&mut *tx).await?;
    let Some(mut job) = job else {
        tx.commit().await?;
        return Ok(false);
    };
    let outcome = match serde_json::from_value::<Notification>(job.payload.clone()) {
        Ok(n) => {
            // Keep the rendering in the same sensitive payload as the source notification.
            // A committed retry retains it; success, expiration and terminal failure scrub both.
            let email = if n.mobile {
                Ok(None)
            } else if !matches!(
                n.purpose.as_str(),
                "verify" | "reset" | "order" | "shipment" | "demo_login"
            ) {
                Err("unsupported_purpose")
            } else if let Some(rendered) = job.payload.get("rendered_email") {
                serde_json::from_value::<RenderedEmail>(rendered.clone())
                    .map(Some)
                    .map_err(|_| "invalid_payload")
            } else {
                match render_notification_in(&mut tx, &n).await {
                    Ok(email) => {
                        job.payload["rendered_email"] =
                            serde_json::to_value(&email).expect("email contains only strings");
                        sqlx::query("UPDATE platform.notification_jobs SET payload=$2 WHERE id=$1")
                            .bind(job.id)
                            .bind(&job.payload)
                            .execute(&mut *tx)
                            .await?;
                        Ok(Some(email))
                    }
                    Err(_) => Err("template_unavailable"),
                }
            };
            match email {
                Ok(email) => {
                    let delivery = match &email {
                        Some(email) => transport.send_rendered(job.id, &n, email),
                        None => transport.send(job.id, &n),
                    };
                    match tokio::time::timeout(Duration::from_secs(15), delivery).await {
                        Ok(result) => result,
                        Err(_) => Err("provider_timeout"),
                    }
                }
                Err(error) => Err(error),
            }
        }
        Err(_) => Err("invalid_payload"),
    };
    match outcome {
        Ok(()) => {
            sqlx::query("UPDATE platform.notification_jobs SET status='delivered',payload=NULL,attempts=attempts+1,last_error=NULL,completed_at=clock_timestamp() WHERE id=$1")
                .bind(job.id).execute(&mut *tx).await?;
            tracing::info!(job_id=%job.id, "notification accepted by delivery provider");
        }
        Err(error) => {
            let terminal = job.attempts >= 4
                || matches!(
                    error,
                    "provider_rejected_permanent"
                        | "invalid_payload"
                        | "invalid_message"
                        | "invalid_recipient"
                        | "invalid_verification_link"
                        | "sms_not_configured"
                        | "unsupported_purpose"
                );
            sqlx::query("UPDATE platform.notification_jobs SET status=CASE WHEN $2 THEN 'failed' ELSE 'pending' END,payload=CASE WHEN $2 THEN NULL ELSE payload END,attempts=attempts+1,last_error=$3,available_at=clock_timestamp()+make_interval(secs=>$4),completed_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1")
                .bind(job.id).bind(terminal).bind(error).bind(f64::from(5 * 2_i32.pow(job.attempts.min(4) as u32)))
                .execute(&mut *tx).await?;
            tracing::warn!(job_id=%job.id, code=error, terminal, "notification delivery failed");
        }
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn worker<T: Transport>(pool: PgPool, transport: T) {
    loop {
        match deliver_one(&pool, &transport).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(_) => tracing::warn!("notification queue unavailable"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod smtp_tests {
    use super::*;
    fn smtp(port: &str, origin: &str) -> Result<Smtp, &'static str> {
        Smtp::new(
            "mail.privateemail.com",
            port,
            "info@example.test",
            "test-secret".into(),
            "Rocento <info@example.test>",
            origin,
        )
    }
    fn notification() -> Notification {
        Notification {
            identifier: "customer@example.test".into(),
            purpose: "verify".into(),
            code: "private-token".into(),
            mobile: false,
            link: "https://store.example.test/verify?token=private-token".into(),
        }
    }
    #[test]
    fn production_never_uses_test_delivery() {
        assert!(validate_mode("production", "console").is_err());
        assert!(validate_mode("production", "mailpit").is_err());
        assert!(validate_mode("production", "smtp").is_ok());
        assert!(validate_mode("development", "mailpit").is_ok());
        assert!(validate_mode("production", "").is_err());
    }
    #[tokio::test]
    async fn secure_configuration_only() {
        assert!(smtp("465", "https://store.example.test").is_ok());
        assert!(smtp("587", "https://store.example.test").is_ok());
        assert!(smtp("25", "https://store.example.test").is_err());
        assert!(smtp("465", "http://store.example.test").is_err());
    }
    #[tokio::test]
    async fn messages_preserve_link_and_stable_id() {
        let transport = smtp("465", "https://store.example.test").unwrap();
        let id = Uuid::new_v4();
        let n = notification();
        let text = String::from_utf8(transport.message(id, &n).unwrap().formatted()).unwrap();
        assert!(text.contains("Verify your Rocento account"));
        assert!(text.contains(&format!("{id}@example.test")));
        assert!(text.contains("15 minutes"));
        let mut reset = n.clone();
        reset.purpose = "reset".into();
        assert!(transport.message(id, &reset).is_ok());
    }

    #[tokio::test]
    async fn commerce_messages_include_html_and_plain_text_without_authentication_instructions() {
        let transport = smtp("465", "https://store.example.test").unwrap();
        for (purpose, content, subject) in [
            (
                "order",
                "Order #42 confirmed. Total: 125.50 EGP. Payment: Cash on Delivery.",
                "Your Rocento order confirmation",
            ),
            (
                "shipment",
                "Order #42 has shipped. Tracking reference: SECOND-PARCEL",
                "Your Rocento order has shipped",
            ),
        ] {
            let id = Uuid::new_v4();
            let mut n = notification();
            n.purpose = purpose.into();
            n.link = content.into();
            for _ in 0..2 {
                let text =
                    String::from_utf8(transport.message(id, &n).unwrap().formatted()).unwrap();
                assert!(text.contains(&format!("Subject: {subject}")));
                assert!(text.contains("Content-Type: multipart/alternative"));
                assert!(text.contains("Content-Type: text/plain"));
                assert!(text.contains("Content-Type: text/html"));
                assert!(text.contains(content));
                assert!(text.contains(&format!("Message-ID: <{id}@example.test>")));
                assert!(!text.contains("15 minutes"));
                assert!(!text.contains("only be used once"));
                assert!(!text.contains("private-token"));
            }
            // The commerce body must not bypass verification/reset URL validation.
            for auth_purpose in ["verify", "reset"] {
                n.purpose = auth_purpose.into();
                assert_eq!(
                    transport.message(id, &n).unwrap_err(),
                    "invalid_verification_link"
                );
                for invalid in [
                    "https://attacker.example/verify",
                    "http://store.example.test/verify",
                    "https://user:password@store.example.test/verify",
                ] {
                    n.link = invalid.into();
                    assert_eq!(
                        transport.message(id, &n).unwrap_err(),
                        "invalid_verification_link"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn commerce_messages_reject_oversized_and_control_character_bodies() {
        let transport = smtp("465", "https://store.example.test").unwrap();
        let id = Uuid::new_v4();
        for purpose in ["order", "shipment"] {
            let mut n = notification();
            n.purpose = purpose.into();
            for body in ["x".repeat(2048), "Order #42\nTracking:\tREF".into()] {
                n.link = body;
                assert!(transport.message(id, &n).is_ok());
            }
            for body in [
                "x".repeat(2049),
                "é".repeat(1025),
                " \t\n".into(),
                "Order #42\r\nBcc: victim@example.test".into(),
                "Order #42\0".into(),
                "Order #42\x1b".into(),
            ] {
                n.link = body;
                // Validation fails before the transport could contact SMTP.
                assert_eq!(transport.send(id, &n).await, Err("invalid_message"));
            }
        }
    }

    #[tokio::test]
    async fn invalid_delivery_never_contacts_provider() {
        let transport = smtp("465", "https://store.example.test").unwrap();
        let id = Uuid::new_v4();
        let mut n = notification();
        n.mobile = true;
        assert_eq!(transport.send(id, &n).await, Err("sms_not_configured"));
        n.mobile = false;
        n.link = "https://attacker.example/verify".into();
        assert_eq!(
            transport.send(id, &n).await,
            Err("invalid_verification_link")
        );
        n = notification();
        n.identifier = "user@example.test\r\nBcc: other@example.test".into();
        assert_eq!(transport.send(id, &n).await, Err("invalid_recipient"));
    }

    #[tokio::test]
    async fn smtp_uses_rendered_content_and_revalidates_auth_links() {
        let transport = smtp("465", "https://store.example.test").unwrap();
        let id = Uuid::new_v4();
        let mut n = notification();
        let email = RenderedEmail {
            subject: "Published account subject".into(),
            text: "Published account body".into(),
            html: "<p>Published account body</p>".into(),
        };
        let formatted = String::from_utf8(
            transport
                .message_with_email(id, &n, &email)
                .unwrap()
                .formatted(),
        )
        .unwrap();
        assert!(formatted.contains("Subject: Published account subject"));
        assert!(formatted.contains("Content-Type: multipart/alternative"));
        assert!(formatted.contains("Content-Type: text/html"));
        assert!(formatted.contains("Content-Type: text/plain"));
        assert!(formatted.contains("<p>Published account body</p>"));
        assert!(!formatted.contains("Verify your Rocento account"));
        for purpose in ["verify", "reset"] {
            n.purpose = purpose.into();
            for link in [
                "https://attacker.example/verify",
                "http://store.example.test/verify",
                "https://user:secret@store.example.test/verify",
            ] {
                n.link = link.into();
                assert_eq!(
                    transport.send_rendered(id, &n, &email).await,
                    Err("invalid_verification_link")
                );
            }
        }
        n = notification();
        let malformed = RenderedEmail {
            subject: "Hello\r\nBcc: victim@example.test".into(),
            ..email
        };
        assert_eq!(
            transport.send_rendered(id, &n, &malformed).await,
            Err("invalid_message")
        );
    }

    #[tokio::test]
    async fn mailpit_revalidates_auth_links_with_custom_rendered_content() {
        let transport = Mailpit::new_with_storefront(
            "http://127.0.0.1:1",
            "store@example.test",
            "http://localhost:5173",
        )
        .unwrap();
        let id = Uuid::new_v4();
        let mut n = notification();
        let email = RenderedEmail {
            subject: "Published subject".into(),
            text: "Published text".into(),
            html: "<p>Published HTML</p>".into(),
        };
        for purpose in ["verify", "reset"] {
            n.purpose = purpose.into();
            for link in [
                "https://attacker.example/verify",
                "http://user:secret@localhost:5173/verify",
                "http://localhost:5174/verify",
            ] {
                n.link = link.into();
                assert_eq!(
                    transport.send_rendered(id, &n, &email).await,
                    Err("invalid_verification_link")
                );
            }
        }
        n.link = "http://localhost:5173/verify?token=synthetic".into();
        n.identifier = "user@example.test\r\nBcc: victim@example.test".into();
        assert_eq!(
            transport.send_rendered(id, &n, &email).await,
            Err("invalid_recipient")
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn smtp_serializes_published_template_content(pool: PgPool) {
        let content = serde_json::json!({
            "subject": "Published SMTP confirmation", "heading": "Published heading",
            "body": "Published body {{message}}", "cta_label": null,
        });
        sqlx::query("INSERT INTO platform.email_template_versions(template_key,version,content,change_note,published_by) VALUES('order',1,$1,'SMTP integration test',$2)")
            .bind(content).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        sqlx::query("UPDATE platform.email_templates SET published_version=1 WHERE key='order'")
            .execute(&pool)
            .await
            .unwrap();
        let transport = smtp("465", "https://store.example.test").unwrap();
        let mut n = notification();
        n.purpose = "order".into();
        n.link = "Order <script>bad</script> & fragile".into();
        let email = crate::email_templates::render_notification(&pool, &n)
            .await
            .unwrap();
        assert_eq!(email.subject, "Published SMTP confirmation");
        assert!(email.html.contains("&lt;script&gt;"));
        assert!(!email.html.contains("<script>"));
        let formatted = String::from_utf8(
            transport
                .message_with_email(Uuid::new_v4(), &n, &email)
                .unwrap()
                .formatted(),
        )
        .unwrap();
        assert!(formatted.contains("Subject: Published SMTP confirmation"));
        assert!(formatted.contains("Content-Type: multipart/alternative"));
        assert!(formatted.contains("Content-Type: text/plain"));
        assert!(formatted.contains("Content-Type: text/html"));
        assert!(formatted.contains("Published body"));
        assert!(formatted.contains("&lt;script&gt;"));
        assert!(!formatted.contains("Your Rocento order confirmation"));
    }
}
