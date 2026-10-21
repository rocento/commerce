//! Explicitly scoped security alerts; no credentials or session tokens enter email jobs.
use crate::{auth_ip::AuthIpRateLimit, email_templates::RenderedEmail};
use axum::http::HeaderMap;
use infra_auth::{Error, Notification, Result};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::{net::IpAddr, time::Duration};
use uuid::Uuid;

pub const PURPOSE: &str = "demo_login";
const ACCOUNT: &str = "demo@rocento.com";
const RECIPIENT: &str = "info@rocento.com";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Details {
    account: String,
    surface: String,
    storefront: String,
    at: String,
    ip: Option<IpAddr>,
}
fn client_ip(mode: AuthIpRateLimit, headers: &HeaderMap, peer: Option<IpAddr>) -> Option<IpAddr> {
    // Managed ingress overwrites this header with its trusted real client IP.
    // Never take the first entry of a caller-provided forwarding chain.
    let ip = if mode == AuthIpRateLimit::Ingress {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
    } else {
        peer
    };
    ip.map(|ip| match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    })
}
pub async fn enqueue(
    pool: &PgPool,
    email: &str,
    surface: &str,
    storefront: &str,
    mode: AuthIpRateLimit,
    headers: &HeaderMap,
    peer: Option<IpAddr>,
) -> Result<()> {
    if !email.eq_ignore_ascii_case(ACCOUNT) {
        return Ok(());
    }
    let details = Details {
        account: ACCOUNT.into(),
        surface: surface.into(),
        storefront: storefront.into(),
        at: chrono::Utc::now().to_rfc3339(),
        ip: client_ip(mode, headers, peer),
    };
    let notification = Notification {
        identifier: RECIPIENT.into(),
        purpose: PURPOSE.into(),
        code: String::new(),
        link: serde_json::to_string(&details).map_err(|_| Error::Internal)?,
        mobile: false,
    };
    let mut tx = pool.begin().await?;
    infra_auth::notifications::enqueue(&mut tx, Uuid::new_v4(), None, None, &notification, 86400)
        .await?;
    tx.commit().await?;
    Ok(())
}
fn details(n: &Notification) -> Result<Details> {
    if n.purpose != PURPOSE
        || n.identifier != RECIPIENT
        || n.mobile
        || !n.code.is_empty()
        || n.link.len() > 2048
    {
        return Err(Error::Invalid("Invalid login alert".into()));
    }
    let d: Details =
        serde_json::from_str(&n.link).map_err(|_| Error::Invalid("Invalid login alert".into()))?;
    if d.account != ACCOUNT
        || !["admin", "customer"].contains(&d.surface.as_str())
        || chrono::DateTime::parse_from_rfc3339(&d.at).is_err()
    {
        return Err(Error::Invalid("Invalid login alert".into()));
    }
    Ok(d)
}
pub fn validate(n: &Notification) -> bool {
    details(n).is_ok()
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_documentation()
                || v.octets()[0] == 0
                || v.octets()[0] >= 240
                || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1])))
        }
        IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_ip(IpAddr::V4(v)))
            .unwrap_or_else(|| {
                !(v.is_loopback()
                    || v.is_unspecified()
                    || v.is_multicast()
                    || v.is_unique_local()
                    || v.is_unicast_link_local()
                    || (v.segments()[0] == 0x2001 && v.segments()[1] == 0xdb8))
            }),
    }
}
async fn lookup(ip: IpAddr) -> Option<String> {
    if !public_ip(ip) || std::env::var("APP_ENV").as_deref() == Ok("development") {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(format!(
            "https://ipwho.is/{ip}?fields=success,city,region,country"
        ))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let value: serde_json::Value = response.json().await.ok()?;
    location(&value)
}
fn location(value: &serde_json::Value) -> Option<String> {
    if value["success"] != true {
        return None;
    }
    let parts: Vec<&str> = ["city", "region", "country"]
        .iter()
        .filter_map(|key| value[*key].as_str())
        .filter(|s| !s.trim().is_empty() && s.len() <= 150 && !s.chars().any(char::is_control))
        .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}
fn escaped(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn email(d: &Details, location: Option<String>) -> RenderedEmail {
    let subject = "Rocento: demo account login".into();
    let text = format!("A successful login to {} occurred.\n\nLogin type: {}\nStore: {}\nTime (UTC): {}\nIP address: {}\nApproximate location: {}\n\nIP location is approximate and may reflect a VPN or mobile network.\nThis alert is enabled only for demo@rocento.com.", d.account, d.surface, d.storefront, d.at, d.ip.map(|v| v.to_string()).unwrap_or_else(|| "Unavailable".into()), location.unwrap_or_else(|| "Unavailable".into()));
    let html = format!(
        "<!doctype html><html><body><h1>Demo account login</h1><p>{}</p></body></html>",
        escaped(&text).replace('\n', "<br>")
    );
    RenderedEmail {
        subject,
        text,
        html,
    }
}
pub fn render_builtin(n: &Notification) -> Result<RenderedEmail> {
    Ok(email(&details(n)?, None))
}
pub async fn render(n: &Notification) -> Result<RenderedEmail> {
    let d = details(n)?;
    let location = match d.ip {
        Some(ip) => lookup(ip).await,
        None => None,
    };
    Ok(email(&d, location))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwarding_is_trusted_only_in_ingress_mode() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "8.8.8.8".parse().unwrap());
        let peer = Some("127.0.0.1".parse().unwrap());
        assert_eq!(client_ip(AuthIpRateLimit::Peer, &headers, peer), peer);
        assert_eq!(
            client_ip(AuthIpRateLimit::Ingress, &headers, peer),
            Some("8.8.8.8".parse().unwrap())
        );
        headers.insert("x-forwarded-for", "8.8.8.8, 1.1.1.1".parse().unwrap());
        assert_eq!(client_ip(AuthIpRateLimit::Ingress, &headers, peer), None);
    }
    #[test]
    fn private_ips_and_unavailable_location_are_handled() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "::ffff:192.168.1.1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()));
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert_eq!(
            location(&serde_json::json!({"success":false,"city":"ignored"})),
            None
        );
        assert_eq!(
            location(&serde_json::json!({"success":true,"city":"Cairo","country":"Egypt"})),
            Some("Cairo, Egypt".into())
        );
    }
    #[test]
    fn alert_recipient_is_fixed_and_html_is_escaped() {
        let d = Details {
            account: ACCOUNT.into(),
            surface: "admin".into(),
            storefront: "<script>".into(),
            at: chrono::Utc::now().to_rfc3339(),
            ip: None,
        };
        let mut n = Notification {
            identifier: RECIPIENT.into(),
            purpose: PURPOSE.into(),
            code: String::new(),
            link: serde_json::to_string(&d).unwrap(),
            mobile: false,
        };
        let rendered = render_builtin(&n).unwrap();
        assert!(rendered.text.contains("Unavailable"));
        assert!(!rendered.html.contains("<script>"));
        n.identifier = "other@example.com".into();
        assert!(render_builtin(&n).is_err());
    }
}
