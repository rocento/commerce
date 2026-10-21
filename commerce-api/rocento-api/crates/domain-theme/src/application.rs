use crate::domain::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone)]
pub struct Actor {
    pub id: Uuid,
    pub permissions: Vec<String>,
}
impl Actor {
    pub fn allows(&self, operation: &str, channel: &str) -> bool {
        self.permissions.iter().any(|p| {
            p == "*"
                || p == &format!("theme.{operation}")
                || p == &format!("theme.{operation}@{channel}")
        })
    }
    pub fn require(&self, operation: &str, channel: &str) -> Result<()> {
        if self.allows(operation, channel) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRule {
    pub id: Uuid,
    pub theme_id: Uuid,
    pub enabled: bool,
    pub segment_id: Option<Uuid>,
    pub area_id: Option<Uuid>,
    pub stock_id: Option<Uuid>,
    pub city: Option<String>,
}
#[derive(Clone, Default)]
pub struct TargetContext {
    pub segments: Vec<Uuid>,
    pub area_id: Option<Uuid>,
    pub stocks: Vec<Uuid>,
    pub city: Option<String>,
}
impl TargetRule {
    pub fn matches(&self, c: &TargetContext) -> bool {
        self.enabled
            && self.segment_id.is_none_or(|id| c.segments.contains(&id))
            && self.area_id.is_none_or(|id| c.area_id == Some(id))
            && self.stock_id.is_none_or(|id| c.stocks.contains(&id))
            && self.city.as_ref().is_none_or(|city| {
                c.city
                    .as_ref()
                    .is_some_and(|v| v.trim().to_lowercase() == city.trim().to_lowercase())
            })
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Assignment {
    #[serde(default)]
    pub rules: Vec<TargetRule>,
    pub channel: String,
    pub theme_id: Option<Uuid>,
    pub revision: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub name: String,
    pub owner_channel: String,
    pub source: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub expected_revision: i32,
    pub configuration: Configuration,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publish {
    pub expected_revision: i32,
    pub source_version: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assign {
    #[serde(default)]
    pub rules: Vec<TargetRule>,
    pub theme_id: Option<Uuid>,
    pub expected_revision: i32,
}

#[allow(async_fn_in_trait)]
pub trait Repository: Clone + Send + Sync + 'static {
    async fn list(&self) -> Result<Vec<Theme>>;
    async fn get(&self, id: Uuid) -> Result<Theme>;
    async fn assignments(&self) -> Result<Vec<Assignment>>;
    async fn versions(&self, id: Uuid) -> Result<Vec<Version>>;
    async fn version(&self, theme: Uuid, id: Uuid) -> Result<Version>;
    async fn create(
        &self,
        input: &Create,
        configuration: &Configuration,
        actor: Uuid,
    ) -> Result<Theme>;
    async fn save(
        &self,
        id: Uuid,
        revision: i32,
        configuration: &Configuration,
        actor: Uuid,
    ) -> Result<Theme>;
    async fn publish(
        &self,
        id: Uuid,
        revision: i32,
        configuration: &Configuration,
        source: Option<Uuid>,
        actor: Uuid,
    ) -> Result<Version>;
    async fn assign(&self, channel: &str, input: &Assign, actor: Uuid) -> Result<Assignment>;
    async fn validate_assets(&self, configuration: &Configuration) -> Result<()>;
    async fn audit(&self, actor: Uuid, action: &str, id: Uuid) -> Result<()>;
    async fn resolve(&self, channel: &str) -> Result<Option<Version>>;
    async fn resolve_targeted(
        &self,
        channel: &str,
        context: &TargetContext,
    ) -> Result<Option<Version>>;
}
#[derive(Clone)]
pub struct Service<R: Repository> {
    pub repository: R,
}
impl<R: Repository> Service<R> {
    pub async fn list(&self, who: &Actor) -> Result<Vec<Theme>> {
        Ok(self
            .repository
            .list()
            .await?
            .into_iter()
            .filter(|t| who.allows("read", &t.owner_channel))
            .collect())
    }
    pub async fn get(&self, id: Uuid, who: &Actor, operation: &str) -> Result<Theme> {
        let t = self.repository.get(id).await?;
        who.require(operation, &t.owner_channel)?;
        Ok(t)
    }
    pub async fn assignments(&self, who: &Actor) -> Result<Vec<Assignment>> {
        Ok(self
            .repository
            .assignments()
            .await?
            .into_iter()
            .filter(|a| who.allows("read", &a.channel))
            .collect())
    }
    pub async fn create(&self, i: Create, who: &Actor) -> Result<Theme> {
        who.require("create", &i.owner_channel)?;
        if i.name.trim().is_empty() || i.name.len() > 120 {
            return Err(Error::Invalid("name must be 1-120 bytes".into()));
        }
        let configuration = if let Some(id) = i.source {
            self.get(id, who, "read").await?.configuration
        } else {
            default_configuration()
        };
        configuration.validate()?;
        self.repository.validate_assets(&configuration).await?;
        self.repository.create(&i, &configuration, who.id).await
    }
    pub async fn save(&self, id: Uuid, i: Update, who: &Actor) -> Result<Theme> {
        self.get(id, who, "edit").await?;
        i.configuration.validate()?;
        self.repository.validate_assets(&i.configuration).await?;
        self.repository
            .save(id, i.expected_revision, &i.configuration, who.id)
            .await
    }
    pub async fn validate(&self, id: Uuid, who: &Actor) -> Result<Configuration> {
        let t = self.get(id, who, "read").await?;
        t.configuration.validate()?;
        self.repository.validate_assets(&t.configuration).await?;
        self.repository.audit(who.id, "THEME_VALIDATED", id).await?;
        Ok(t.configuration)
    }
    pub async fn preview(&self, id: Uuid, who: &Actor) -> Result<Configuration> {
        let t = self.get(id, who, "preview").await?;
        t.configuration.validate()?;
        self.repository.validate_assets(&t.configuration).await?;
        Ok(t.configuration)
    }
    pub async fn publish(&self, id: Uuid, i: Publish, who: &Actor) -> Result<Version> {
        let operation = if i.source_version.is_some() {
            "rollback"
        } else {
            "publish"
        };
        let t = self.get(id, who, operation).await?;
        if t.revision != i.expected_revision {
            return Err(Error::Conflict);
        }
        for a in self
            .repository
            .assignments()
            .await?
            .iter()
            .filter(|a| a.theme_id == Some(id) || a.rules.iter().any(|r| r.theme_id == id))
        {
            who.require(operation, &a.channel)?;
        }
        let configuration = if let Some(v) = i.source_version {
            self.repository.version(id, v).await?.configuration
        } else {
            t.configuration
        };
        configuration.validate()?;
        configuration.validate_translations_for_publication()?;
        self.repository.validate_assets(&configuration).await?;
        self.repository
            .publish(
                id,
                i.expected_revision,
                &configuration,
                i.source_version,
                who.id,
            )
            .await
    }
    pub async fn versions(&self, id: Uuid, who: &Actor) -> Result<Vec<Version>> {
        self.get(id, who, "read").await?;
        self.repository.versions(id).await
    }
    pub async fn version(&self, id: Uuid, version: Uuid, who: &Actor) -> Result<Version> {
        self.get(id, who, "read").await?;
        self.repository.version(id, version).await
    }
    pub async fn resolve(&self, channel: &str) -> Result<(Option<Uuid>, Configuration)> {
        if channel.is_empty() || channel.len() > 100 {
            return Err(Error::NotFound);
        }
        Ok(self
            .repository
            .resolve(channel)
            .await?
            .map(|v| (Some(v.id), v.configuration))
            .unwrap_or_else(|| (None, default_configuration())))
    }
    pub async fn assign(&self, channel: &str, i: Assign, who: &Actor) -> Result<Assignment> {
        who.require("assign", channel)?;
        if i.rules.len() > 30
            || i.rules
                .iter()
                .map(|r| r.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != i.rules.len()
        {
            return Err(Error::Invalid(
                "Use at most 30 rules with unique IDs".into(),
            ));
        }
        for r in &i.rules {
            if r.segment_id.is_none()
                && r.area_id.is_none()
                && r.stock_id.is_none()
                && r.city.is_none()
            {
                return Err(Error::Invalid(
                    "A targeting rule needs at least one condition".into(),
                ));
            }
            if r.city.as_ref().is_some_and(|v| {
                v.trim().is_empty() || v.len() > 100 || v.chars().any(|c| c.is_control())
            }) {
                return Err(Error::Invalid("City must be 1–100 bytes".into()));
            }
        }
        for id in i
            .theme_id
            .into_iter()
            .chain(i.rules.iter().map(|r| r.theme_id))
        {
            self.get(id, who, "assign").await?;
        }
        self.repository.assign(channel, &i, who.id).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_permissions_are_exact() {
        let who = Actor {
            id: Uuid::new_v4(),
            permissions: vec!["theme.publish@storefront".into()],
        };
        assert!(who.allows("publish", "storefront"));
        assert!(!who.allows("publish", "other"));
        assert!(!who.allows("preview", "storefront"));
    }
}
