//! Where authentication IP throttling is enforced. Ingress mode is an explicit
//! opt-in for gateways reachable only through an ingress enforcing client limits.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum AuthIpRateLimit {
    #[default]
    Peer,
    Ingress,
}

impl AuthIpRateLimit {
    pub fn from_environment() -> Result<Self, &'static str> {
        match std::env::var("AUTH_IP_RATE_LIMIT_MODE") {
            Ok(value) => Self::parse(&value),
            Err(std::env::VarError::NotPresent) => Ok(Self::default()),
            Err(_) => Err("AUTH_IP_RATE_LIMIT_MODE must be peer or ingress"),
        }
    }

    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "peer" => Ok(Self::Peer),
            "ingress" => Ok(Self::Ingress),
            _ => Err("AUTH_IP_RATE_LIMIT_MODE must be peer or ingress"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_throttling_is_the_default() {
        assert_eq!(AuthIpRateLimit::default(), AuthIpRateLimit::Peer);
        assert_eq!(
            AuthIpRateLimit::parse("peer").unwrap(),
            AuthIpRateLimit::Peer
        );
    }

    #[test]
    fn ingress_mode_requires_explicit_configuration() {
        assert_eq!(
            AuthIpRateLimit::parse("ingress").unwrap(),
            AuthIpRateLimit::Ingress
        );
        for value in ["", "true", "none", "off", "Ingress", " ingress "] {
            assert!(AuthIpRateLimit::parse(value).is_err());
        }
    }

    #[test]
    fn raising_chat_allowance_preserves_existing_explicit_installation_caps() {
        let load = |value: &str| {
            PublicAdmission::load(|name| {
                Ok((name == "PUBLIC_ASSISTANT_TOTAL_LIMIT").then(|| value.to_owned()))
            })
        };
        let config = load("120").unwrap();
        assert_eq!(config.assistant.aggregate, 120);
        assert!(config.assistant.source > config.assistant.aggregate);
        assert!(load("119").is_err());
        assert!(load("1000001").is_err());
    }
}

/// Fifteen-minute admission budgets. Aggregate limits are intentionally separate
/// from a visitor's allowance and shared in PostgreSQL across gateway replicas.
#[derive(Clone, Copy)]
pub struct PublicBudget {
    pub subject: i32,
    pub source: i32,
    pub aggregate: i32,
}

#[derive(Clone)]
pub struct PublicAdmission {
    pub support: PublicBudget,
    pub assistant: PublicBudget,
    pub memory: PublicBudget,
    pub analytics: PublicBudget,
}
impl Default for PublicAdmission {
    fn default() -> Self {
        Self {
            support: PublicBudget {
                subject: 20,
                source: 100,
                aggregate: 2000,
            },
            assistant: PublicBudget {
                subject: 120,
                source: 480,
                aggregate: 3000,
            },
            memory: PublicBudget {
                subject: 120,
                source: 600,
                aggregate: 12000,
            },
            analytics: PublicBudget {
                subject: 1000,
                source: 4000,
                aggregate: 100000,
            },
        }
    }
}
impl PublicAdmission {
    pub fn load(
        mut get: impl FnMut(&str) -> Result<Option<String>, &'static str>,
    ) -> Result<Self, &'static str> {
        let mut config = Self::default();
        for (name, budget) in [
            ("PUBLIC_SUPPORT_TOTAL_LIMIT", &mut config.support),
            ("PUBLIC_ASSISTANT_TOTAL_LIMIT", &mut config.assistant),
            ("PUBLIC_MEMORY_TOTAL_LIMIT", &mut config.memory),
            ("PUBLIC_ANALYTICS_TOTAL_LIMIT", &mut config.analytics),
        ] {
            if let Some(value) = get(name)? {
                // Preserve the existing assistant installation range when its
                // per-source headroom grows. A tighter explicit store cap still
                // applies atomically and must not silently grow or stop startup.
                let minimum = if name == "PUBLIC_ASSISTANT_TOTAL_LIMIT" {
                    budget.subject
                } else {
                    budget.source
                };
                let limit = value
                    .parse::<i32>()
                    .ok()
                    .filter(|v| *v >= minimum && *v <= 1_000_000);
                budget.aggregate = limit.ok_or("Public admission totals must be integers within the documented service bounds, up to 1000000")?;
            }
        }
        Ok(config)
    }
    pub fn route(
        &self,
        path: &str,
        method: &axum::http::Method,
    ) -> Option<(&'static str, PublicBudget, &'static str)> {
        if *method == axum::http::Method::POST {
            match path {
                "/v1/support/tickets" => return Some(("support", self.support, "support_guest")),
                "/v1/assistant/chat" => {
                    return Some(("assistant", self.assistant, "assistant_visitor"))
                }
                "/v1/analytics/events" => {
                    return Some(("analytics", self.analytics, "analytics_visitor"))
                }
                _ => {}
            }
        }
        if path == "/v1/assistant/memory" || path.starts_with("/v1/assistant/memory/") {
            return Some(("memory", self.memory, "assistant_visitor"));
        }
        None
    }
}
