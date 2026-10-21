//! Validate security settings before migrations, listeners, or workers start.
use crate::auth_ip::AuthIpRateLimit;
use infra_auth::password::PasswordHashConfig;
use std::time::Duration;

const LOCAL_ORIGINS: &str = "http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175";

// Deliberately no Debug implementation: these structs contain credentials.
pub struct StartupConfig {
    pub database_url: Option<String>,
    pub bind_address: String,
    pub password_hash: PasswordHashConfig,
    pub security: Option<SecurityConfig>,
}

pub struct SecurityConfig {
    pub auth_secret: String,
    pub storefront_url: String,
    pub secure_cookies: bool,
    pub origins: Vec<String>,
    pub notification_mode: String,
    pub auth_ip_rate_limit: AuthIpRateLimit,
    pub public_admission: crate::auth_ip::PublicAdmission,
}

impl StartupConfig {
    pub fn from_environment() -> Result<Self, &'static str> {
        Self::load(|key| match std::env::var(key) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err("Gateway configuration must contain valid Unicode"),
        })
    }

    fn load(
        mut get: impl FnMut(&str) -> Result<Option<String>, &'static str>,
    ) -> Result<Self, &'static str> {
        let database_url = get("DATABASE_URL")?;
        if database_url
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("DATABASE_URL must not be empty");
        }
        let bind_address = get("BIND_ADDRESS")?.unwrap_or_else(|| "0.0.0.0:8080".into());
        let max_concurrency = integer(get("PASSWORD_HASH_MAX_CONCURRENCY")?, 2, 1, 32)
            .ok_or("PASSWORD_HASH_MAX_CONCURRENCY must be an integer from 1 to 32")?;
        let wait_ms = integer(get("PASSWORD_HASH_WAIT_TIMEOUT_MS")?, 250, 1, 5000)
            .ok_or("PASSWORD_HASH_WAIT_TIMEOUT_MS must be an integer from 1 to 5000")?;
        let password_hash = PasswordHashConfig {
            max_concurrency,
            wait_timeout: Duration::from_millis(wait_ms as u64),
        };
        let environment = get("APP_ENV")?.unwrap_or_else(|| "production".into());
        let development = match environment.as_str() {
            "development" => true,
            "production" | "staging" => false,
            _ => return Err("APP_ENV must be development, staging or production"),
        };
        let secure_cookies = match get("COOKIE_SECURE")?.as_deref() {
            Some("true") => true,
            Some("false") => false,
            None => false,
            _ => return Err("COOKIE_SECURE must be true or false"),
        };
        let auth_ip_rate_limit = match get("AUTH_IP_RATE_LIMIT_MODE")? {
            Some(value) => AuthIpRateLimit::parse(&value)?,
            None => AuthIpRateLimit::default(),
        };
        let public_admission = crate::auth_ip::PublicAdmission::load(&mut get)?;
        let security = if database_url.is_some() {
            if !development && !secure_cookies {
                return Err("Production and staging require COOKIE_SECURE=true");
            }
            let auth_secret = get("AUTH_SECRET")?.ok_or("AUTH_SECRET is required")?;
            if auth_secret.len() < 32 || auth_secret.trim().is_empty() {
                return Err("AUTH_SECRET must contain at least 32 random characters");
            }
            let storefront = match get("STOREFRONT_URL")? {
                Some(value) => value,
                None if development => "http://localhost:5173".into(),
                None => return Err("STOREFRONT_URL is required in production and staging"),
            };
            let storefront_url = origin(&storefront, !development).ok_or(
                "STOREFRONT_URL must be a safe HTTP origin; production and staging require HTTPS",
            )?;
            let raw_origins = match get("ALLOWED_ORIGINS")? {
                Some(value) => value,
                None if development => LOCAL_ORIGINS.into(),
                None => return Err("ALLOWED_ORIGINS is required in production and staging"),
            };
            let mut origins = Vec::new();
            for value in raw_origins.split(',') {
                if value.chars().any(char::is_control) {
                    return Err("ALLOWED_ORIGINS must not contain control characters");
                }
                let value = origin(value.trim(), !development)
                    .ok_or("ALLOWED_ORIGINS must contain explicit safe HTTP origins; production and staging require HTTPS")?;
                if !origins.contains(&value) {
                    origins.push(value);
                }
            }
            let notification_mode = get("NOTIFICATION_MODE")?.unwrap_or_default();
            crate::notifications::validate_mode(&environment, &notification_mode)?;
            Some(SecurityConfig {
                auth_secret,
                storefront_url,
                secure_cookies,
                origins,
                notification_mode,
                auth_ip_rate_limit,
                public_admission,
            })
        } else {
            None
        };
        Ok(Self {
            database_url,
            bind_address,
            password_hash,
            security,
        })
    }
}

fn integer(value: Option<String>, default: usize, min: usize, max: usize) -> Option<usize> {
    let value = match value {
        Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
            value.parse().ok()?
        }
        Some(_) => return None,
        None => default,
    };
    (min..=max).contains(&value).then_some(value)
}

fn origin(value: &str, require_https: bool) -> Option<String> {
    if value.is_empty() || value.chars().any(char::is_whitespace) || value.contains(['*', '\\']) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?.trim_end_matches('.');
    if host.is_empty()
        || !matches!(url.scheme(), "http" | "https")
        || (require_https && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || host.contains('*')
    {
        return None;
    }
    if require_https
        && (host == "localhost"
            || host.ends_with(".localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| {
                    let ip = match ip {
                        std::net::IpAddr::V6(ip) => ip
                            .to_ipv4_mapped()
                            .map(std::net::IpAddr::V4)
                            .unwrap_or(std::net::IpAddr::V6(ip)),
                        ip => ip,
                    };
                    ip.is_loopback() || ip.is_unspecified()
                }))
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn settings() -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("DATABASE_URL", "postgres://unused".into()),
            ("APP_ENV", "production".into()),
            ("AUTH_SECRET", "a".repeat(48)),
            ("COOKIE_SECURE", "true".into()),
            ("STOREFRONT_URL", "https://shop.example.com/".into()),
            (
                "ALLOWED_ORIGINS",
                "https://shop.example.com, https://admin.example.com/".into(),
            ),
            ("NOTIFICATION_MODE", "smtp".into()),
        ])
    }

    fn load(values: &BTreeMap<&str, String>) -> Result<StartupConfig, &'static str> {
        StartupConfig::load(|key| Ok(values.get(key).cloned()))
    }

    #[test]
    fn valid_production_settings_are_normalized_once() {
        let config = load(&settings()).unwrap();
        let security = config.security.unwrap();
        assert_eq!(security.storefront_url, "https://shop.example.com");
        assert_eq!(
            security.origins,
            ["https://shop.example.com", "https://admin.example.com"]
        );
        assert!(security.secure_cookies);
        assert_eq!(config.password_hash.max_concurrency, 2);
    }

    #[test]
    fn development_keeps_explicit_local_defaults_and_liveness_needs_no_secrets() {
        let config = load(&BTreeMap::new()).unwrap();
        assert!(config.database_url.is_none());
        assert!(config.security.is_none());
        let mut values = settings();
        values.insert("APP_ENV", "development".into());
        values.insert("NOTIFICATION_MODE", "console".into());
        for key in ["COOKIE_SECURE", "STOREFRONT_URL", "ALLOWED_ORIGINS"] {
            values.remove(key);
        }
        let security = load(&values).unwrap().security.unwrap();
        assert!(!security.secure_cookies);
        assert_eq!(security.storefront_url, "http://localhost:5173");
        assert_eq!(security.origins.len(), 5);
    }

    #[test]
    fn production_and_staging_fail_closed_on_missing_or_insecure_settings() {
        for environment in ["production", "staging"] {
            for key in [
                "AUTH_SECRET",
                "COOKIE_SECURE",
                "STOREFRONT_URL",
                "ALLOWED_ORIGINS",
                "NOTIFICATION_MODE",
            ] {
                let mut values = settings();
                values.insert("APP_ENV", environment.into());
                values.remove(key);
                assert!(load(&values).is_err(), "{environment}: {key}");
            }
            for (key, value) in [
                ("COOKIE_SECURE", "false"),
                ("AUTH_SECRET", "short"),
                ("STOREFRONT_URL", "http://shop.example.com"),
                ("ALLOWED_ORIGINS", "http://shop.example.com"),
                ("NOTIFICATION_MODE", "console"),
                ("NOTIFICATION_MODE", "mailpit"),
            ] {
                let mut values = settings();
                values.insert("APP_ENV", environment.into());
                values.insert(key, value.into());
                assert!(load(&values).is_err(), "{environment}: {key}");
            }
        }
    }

    #[test]
    fn malformed_values_are_rejected_without_echoing_credentials() {
        for (key, value) in [
            ("COOKIE_SECURE", "TRUE"),
            ("COOKIE_SECURE", "1"),
            ("APP_ENV", "prod"),
            ("AUTH_IP_RATE_LIMIT_MODE", "off"),
            ("PASSWORD_HASH_MAX_CONCURRENCY", "0"),
            ("PASSWORD_HASH_MAX_CONCURRENCY", "33"),
            ("PASSWORD_HASH_MAX_CONCURRENCY", "+2"),
            ("PASSWORD_HASH_WAIT_TIMEOUT_MS", "0"),
            ("PASSWORD_HASH_WAIT_TIMEOUT_MS", "5001"),
            ("PASSWORD_HASH_WAIT_TIMEOUT_MS", "250ms"),
        ] {
            let mut values = settings();
            values.insert(key, value.into());
            assert!(load(&values).is_err(), "{key}: {value}");
        }
        let mut values = settings();
        values.insert("AUTH_SECRET", "sensitive-short-secret".into());
        assert!(!load(&values)
            .err()
            .unwrap()
            .contains("sensitive-short-secret"));
    }

    #[test]
    fn origins_reject_wildcards_credentials_paths_and_ambiguous_urls() {
        for value in [
            "*",
            "null",
            "https://*.example.com",
            "https://user:secret@example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://example.com#x",
            "https://example.com\n",
            "https://example.com\\evil",
            "https://localhost",
            "https://localhost.",
            "https://shop.localhost.",
            "https://%2a.example.com",
            "https://.",
            "https://127.0.0.1",
            "https://[::1]",
            "https://[::ffff:127.0.0.1]",
            "https://0.0.0.0",
            "",
        ] {
            assert!(origin(value, true).is_none(), "{value}");
            let mut values = settings();
            values.insert(
                "ALLOWED_ORIGINS",
                format!("https://shop.example.com,{value}"),
            );
            assert!(load(&values).is_err(), "{value}");
        }
    }
}
