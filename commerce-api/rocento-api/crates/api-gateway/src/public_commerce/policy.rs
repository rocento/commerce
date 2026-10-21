use crate::discoverability::Settings;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, Default)]
pub struct Deployment {
    pub installation_id: Option<Uuid>,
    pub environment: String,
    pub approved_origin: Option<String>,
    pub header_override: bool,
    pub html: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EffectivePolicy {
    pub installation_id: Option<Uuid>,
    pub settings_revision: i32,
    pub merchant_preference: bool,
    pub state: &'static str,
    pub environment: String,
    pub canonical_origin: Option<String>,
    pub response_header: &'static str,
    pub robots_meta: &'static str,
    pub robots_txt: String,
    pub deployment_override: bool,
    pub external_headers: &'static str,
    pub warnings: Vec<&'static str>,
}

/// Only root HTTPS DNS origins can be approved. No implicit trust in user input.
pub fn production_origin(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || host.parse::<std::net::IpAddr>().is_ok()
        || !host.contains('.')
        || host.ends_with('.')
        || host.len() > 253
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "admin",
                    "demo",
                    "staging",
                    "stage",
                ]
                .contains(&label)
                || label.ends_with("-admin")
                || label.starts_with("admin-")
        })
    {
        return None;
    }
    Some(format!("https://{host}/"))
}

impl Deployment {
    pub fn allows_attribution(&self, database_id: Uuid) -> bool {
        self.installation_id == Some(database_id) && self.approved_origin.is_some()
    }

    pub async fn from_environment(pool: &sqlx::PgPool) -> Result<Self, Box<dyn std::error::Error>> {
        let id: Uuid = sqlx::query_scalar(
            "SELECT installation_id FROM platform.publication_installation WHERE singleton",
        )
        .fetch_one(pool)
        .await?;
        let environment =
            std::env::var("PUBLICATION_ENVIRONMENT").unwrap_or_else(|_| "development".into());
        if !["development", "production", "demo", "staging", "admin"]
            .contains(&environment.as_str())
        {
            return Err("Invalid PUBLICATION_ENVIRONMENT".into());
        }
        let binding = std::env::var("PUBLICATION_INSTALLATION_ID").ok();
        Self::verify_binding(id, binding.as_deref(), environment == "production")?;
        let approved_origin = std::env::var("PUBLICATION_APPROVED_ORIGIN").ok();
        if approved_origin
            .as_ref()
            .is_some_and(|s| production_origin(s).as_ref() != Some(s))
        {
            return Err("PUBLICATION_APPROVED_ORIGIN must be an approved root HTTPS DNS origin with trailing slash".into());
        }
        let header_override = match std::env::var("PUBLICATION_NOINDEX").as_deref() {
            Ok("false") => false,
            Ok("true") | Err(_) => true,
            _ => return Err("PUBLICATION_NOINDEX must be true or false".into()),
        };
        let html = std::env::var("PUBLICATION_INDEX_PATH")
            .ok()
            .map(std::fs::read_to_string)
            .transpose()?;
        if environment == "production"
            && (binding.is_none() || approved_origin.is_none() || html.is_none())
        {
            return Err("Production publication requires installation binding, approved origin and built index path".into());
        }
        if let Some(ref html) = html {
            if !html.contains("</head>")
                || html.to_ascii_lowercase().contains("name=\"robots\"")
                || html.to_ascii_lowercase().contains("name='robots'")
            {
                return Err(
                    "Publication index must contain </head> and no existing robots meta".into(),
                );
            }
        }
        Ok(Self {
            installation_id: Some(id),
            environment,
            approved_origin,
            header_override,
            html,
        })
    }

    pub fn verify_binding(
        actual: Uuid,
        supplied: Option<&str>,
        required: bool,
    ) -> Result<(), &'static str> {
        match supplied {
            Some(value) if value.parse::<Uuid>().ok() == Some(actual) => Ok(()),
            None if !required => Ok(()),
            _ => Err("Publication installation binding missing or mismatched"),
        }
    }

    pub fn validate_canonical(&self, value: Option<&str>) -> bool {
        value.is_none_or(|v| {
            production_origin(v).is_some_and(|origin| {
                // Unprovisioned installations can save identity, but can never become indexable.
                self.approved_origin
                    .as_ref()
                    .is_none_or(|approved| *approved == origin)
            })
        })
    }

    pub fn accepts_host(&self, headers: &axum::http::HeaderMap) -> bool {
        let Some(origin) = self.approved_origin.as_deref() else {
            return false;
        };
        let expected = origin.trim_start_matches("https://").trim_end_matches('/');
        // Forwarded/X-Forwarded-Host are deliberately ignored, even on direct requests.
        headers.get_all("host").iter().count() == 1
            && headers
                .get("host")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|host| {
                    host.eq_ignore_ascii_case(expected)
                        || host.eq_ignore_ascii_case(&format!("{expected}:443"))
                })
    }

    pub fn resolve(&self, settings: &Settings) -> EffectivePolicy {
        let canonical = settings
            .canonical_url
            .as_deref()
            .and_then(production_origin)
            .filter(|origin| self.approved_origin.as_ref() == Some(origin));
        let (state, warning) = if self.environment != "production" {
            (
                "BLOCKED_BY_ENVIRONMENT",
                "Only a provisioned production merchant installation can be indexable.",
            )
        } else if self.installation_id.is_none() || self.html.is_none() {
            ("CONFIGURATION_ERROR", "Bind this gateway to its installation and built storefront before enabling publication.")
        } else if canonical.is_none() {
            ("DOMAIN_UNVERIFIED", "Configure the merchant canonical URL to match the operator-approved production origin.")
        } else if self.header_override {
            ("BLOCKED_BY_HEADER", "The deployment noindex override must be removed by the operator after verification.")
        } else if !settings.enabled || !settings.indexing_enabled {
            (
                "MERCHANT_DISABLED",
                "Enable public discovery and the merchant indexing preference to permit indexing.",
            )
        } else {
            ("INDEXABLE", "Eligibility does not guarantee indexing. Verify the public CDN response before launch.")
        };
        let directive = if state == "INDEXABLE" {
            "index, follow"
        } else {
            "noindex, nofollow"
        };
        EffectivePolicy {
            installation_id: self.installation_id,
            settings_revision: settings.revision,
            merchant_preference: settings.enabled && settings.indexing_enabled,
            state,
            environment: self.environment.clone(),
            canonical_origin: canonical,
            response_header: directive,
            robots_meta: directive,
            // Allow crawling on production so crawlers can observe noindex when disabled.
            robots_txt: if self.environment == "production" {
                "User-agent: *\nAllow: /\nDisallow: /api/\nAllow: /api/v1/catalog/media/*/content\n"
                    .into()
            } else {
                "User-agent: *\nDisallow: /\n".into()
            },
            deployment_override: self.header_override,
            external_headers: "NOT_OBSERVED",
            warnings: vec![warning],
        }
    }
}

pub fn public_page(path: &str) -> bool {
    path == "/"
        || ["/products/", "/categories/", "/pages/"]
            .iter()
            .any(|prefix| {
                path.strip_prefix(prefix)
                    .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        serde_json::from_value(serde_json::json!({
            "revision":1,"enabled":true,"indexing_enabled":true,"llms_txt_enabled":false,
            "site_name":"Merchant","organization_name":"Merchant","canonical_url":"https://shop.example.test/",
            "description":"Store","default_locale":"en","feature_pages_enabled":false,"industry_pages_enabled":false,
            "docs_enabled":false,"pricing_page_enabled":false,"security_page_enabled":false,"integrations_page_enabled":false,
            "changelog_enabled":false,"grocery_demo_url":null,"jewelry_demo_url":null,"updated_at":"2026-09-21T00:00:00Z"
        })).unwrap()
    }
    #[test]
    fn attribution_requires_origin_and_matching_binding_independent_of_indexing() {
        let id = Uuid::new_v4();
        let mut deployment = Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: true,
            html: None,
        };
        assert!(deployment.allows_attribution(id));
        assert!(!deployment.allows_attribution(Uuid::new_v4()));
        deployment.approved_origin = None;
        assert!(!deployment.allows_attribution(id));
        deployment.environment = "demo".into();
        assert!(!deployment.allows_attribution(id));
    }
    #[test]
    fn origin_validation_rejects_nonpublic_and_unsafe_authorities() {
        for origin in [
            "http://shop.example/",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://admin.example/",
            "https://demo.example/",
            "https://jewelry-admin.example/",
            "https://shop.local/",
            "https://shop.example:444/",
            "https://u:p@shop.example/",
            "https://shop.example/path",
            "https://shop.example/?x=1",
            "https://shop.example/#x",
            "https://shop.example./",
            "https://bad_host.example/",
        ] {
            assert!(production_origin(origin).is_none(), "{origin}");
        }
        assert_eq!(
            production_origin("https://shop.example.test/"),
            Some("https://shop.example.test/".into())
        );
    }
    #[test]
    fn precedence_and_consistent_directives() {
        let mut d = Deployment {
            installation_id: Some(Uuid::new_v4()),
            environment: "production".into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: false,
            html: Some("</head>".into()),
        };
        let mut s = settings();
        assert_eq!(d.resolve(&s).state, "INDEXABLE");
        s.indexing_enabled = false;
        assert_eq!(d.resolve(&s).state, "MERCHANT_DISABLED");
        d.header_override = true;
        assert_eq!(d.resolve(&s).state, "BLOCKED_BY_HEADER");
        s.canonical_url = Some("https://another.example.test/".into());
        assert_eq!(d.resolve(&s).state, "DOMAIN_UNVERIFIED");
        d.installation_id = None;
        assert_eq!(d.resolve(&s).state, "CONFIGURATION_ERROR");
        for environment in ["demo", "staging", "admin", "development"] {
            d.environment = environment.into();
            let p = d.resolve(&s);
            assert_eq!(p.state, "BLOCKED_BY_ENVIRONMENT");
            assert_eq!(p.response_header, p.robots_meta);
            assert_eq!(p.response_header, "noindex, nofollow");
            assert!(p.robots_txt.contains("Disallow: /"));
        }
    }
    #[test]
    fn forwarded_hosts_never_authorize_or_change_origin() {
        let d = Deployment {
            approved_origin: Some("https://shop.example.test/".into()),
            ..Default::default()
        };
        let mut h = axum::http::HeaderMap::new();
        h.insert("host", "attacker.example".parse().unwrap());
        h.insert("x-forwarded-host", "shop.example.test".parse().unwrap());
        assert!(!d.accepts_host(&h));
        h.insert("host", "shop.example.test".parse().unwrap());
        h.insert("forwarded", "host=attacker.example".parse().unwrap());
        assert!(d.accepts_host(&h));
        assert!(!d.validate_canonical(Some("https://another.example.test/")));
        h.append("host", "shop.example.test".parse().unwrap());
        assert!(!d.accepts_host(&h));
    }
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    #[test]
    fn production_binding_cannot_select_another_database() {
        let actual = Uuid::new_v4();
        assert!(Deployment::verify_binding(actual, Some(&actual.to_string()), true).is_ok());
        assert!(
            Deployment::verify_binding(actual, Some(&Uuid::new_v4().to_string()), true).is_err()
        );
        assert!(Deployment::verify_binding(actual, None, true).is_err());
        assert!(Deployment::verify_binding(actual, Some("invalid"), false).is_err());
        assert!(Deployment::verify_binding(actual, None, false).is_ok());
    }
}

/// Internal JSON APIs are never an indexable surface, including direct origin access.
pub async fn api_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let internal = request.uri().path().starts_with("/v1/")
        || ["/health", "/ready", "/metrics", "/openapi.json"].contains(&request.uri().path());
    let mut response = next.run(request).await;
    if internal {
        response
            .headers_mut()
            .insert("x-robots-tag", "noindex, nofollow".parse().unwrap());
    }
    response
}
