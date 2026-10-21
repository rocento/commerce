//! Profiles describe catalog semantics. This module never reads or writes themes.
use crate::{bad, AttributeSet, Definition, Service, SetMember};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateAttribute {
    pub group: String,
    pub definition: Definition,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndustryProfile {
    pub id: Uuid,
    // Built-in templates acquire numeric identity when persisted for a store.
    #[serde(default, skip_serializing_if = "crate::missing_entity_id")]
    pub entity_id: i64,
    pub code: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub version: i32,
    pub metadata: Value,
    pub template: Vec<TemplateAttribute>,
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Configuration {
    pub industry_profile_id: Option<Uuid>,
    pub default_attribute_set_id: Option<Uuid>,
    pub version: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apply {
    pub profile_id: Uuid,
    pub profile_version: i32,
    pub expected_version: i32,
    pub selected_codes: Vec<String>,
    pub confirmed: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct PreviewAttribute {
    pub code: String,
    pub label: String,
    pub group: String,
    pub action: String,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub configuration: Configuration,
    pub profile: IndustryProfile,
    pub attributes: Vec<PreviewAttribute>,
}
pub fn templates() -> Vec<IndustryProfile> {
    serde_json::from_str(include_str!("../templates/industries.json"))
        .expect("validated built-in industry templates")
}
fn compatible(existing: &Definition, recommended: &Definition) -> bool {
    crate::metadata::canonical_type(&existing.input_type)
        == crate::metadata::canonical_type(&recommended.input_type)
        && existing.metadata.active()
        && (recommended.metadata.source_policy != "trusted_only"
            || existing.metadata.source_policy == "trusted_only")
        && recommended.options.as_array().is_some_and(|options| {
            options.iter().all(|o| {
                existing
                    .options
                    .as_array()
                    .is_some_and(|current| current.iter().any(|c| c["value"] == o["value"]))
            })
        })
        && existing.metadata.unit == recommended.metadata.unit
}
impl Service {
    pub async fn configuration(&self) -> Result<Configuration> {
        Ok(sqlx::query_as("SELECT industry_profile_id,default_attribute_set_id,version FROM attributes.catalog_configuration WHERE singleton").fetch_one(&self.pool).await?)
    }
    pub async fn profiles(&self) -> Result<Vec<IndustryProfile>> {
        let mut profiles = templates();
        type ProfileRow = (Uuid, i64, String, String, String, String, i32, Value, Value);
        let rows: Vec<ProfileRow>=sqlx::query_as("SELECT id,entity_id,code,name,description,status,version,metadata,template FROM attributes.industry_profiles ORDER BY name").fetch_all(&self.pool).await?;
        for (id, entity_id, code, name, description, status, version, metadata, template) in rows {
            if let Some(profile) = profiles.iter_mut().find(|p| p.id == id) {
                profile.entity_id = entity_id;
            } else {
                profiles.push(IndustryProfile {
                    id,
                    entity_id,
                    code,
                    name,
                    description,
                    status,
                    version,
                    metadata,
                    template: serde_json::from_value(template).map_err(|_| Error::Internal)?,
                });
            }
        }
        Ok(profiles)
    }
    /// First-client setup only. Repeated provisioning preserves all merchant changes.
    /// A profile switch must use the explicit preview/apply flow, not onboarding.
    pub async fn onboard_industry(
        &self,
        profile_id: Uuid,
        expected_version: i32,
    ) -> Result<Configuration> {
        let current = self.configuration().await?;
        if current.version != expected_version {
            return Err(Error::Conflict);
        }
        if let Some(existing) = current.industry_profile_id {
            if existing != profile_id {
                return Err(bad("This client already has a different industry. Use Admin to preview and confirm an industry change."));
            }
            return Ok(current);
        }
        let profile = self
            .profiles()
            .await?
            .into_iter()
            .find(|p| p.id == profile_id)
            .ok_or(Error::NotFound)?;
        self.apply_industry(Apply {
            profile_id,
            profile_version: profile.version,
            expected_version,
            selected_codes: profile
                .template
                .iter()
                .map(|a| a.definition.attribute_code.clone())
                .collect(),
            confirmed: true,
        })
        .await
    }

    pub async fn save_profile(&self, mut profile: IndustryProfile) -> Result<IndustryProfile> {
        if templates()
            .iter()
            .any(|p| p.id == profile.id || p.code == profile.code)
        {
            return Err(bad(
                "Platform templates are read-only; create a custom profile with a new code",
            ));
        }
        if profile.code.is_empty()
            || profile.code.len() > 64
            || !profile
                .code
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            || profile.name.trim().is_empty()
            || profile.name.len() > 120
            || profile.description.len() > 2000
            || !["active", "disabled"].contains(&profile.status.as_str())
            || profile.template.len() > 100
            || !profile.metadata.is_object()
            || profile.metadata.to_string().len() > 4000
        {
            return Err(bad("Invalid industry profile"));
        }
        let mut seen = std::collections::HashSet::new();
        for member in &profile.template {
            if member.group.is_empty()
                || member.group.len() > 80
                || member.definition.entity_type != "product"
                || !seen.insert(&member.definition.attribute_code)
            {
                return Err(bad("Invalid profile attribute groups or duplicate codes"));
            }
            crate::validate_definition(&member.definition)?;
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let old: Option<(i32, String)> =
            sqlx::query_as("SELECT version,code FROM attributes.industry_profiles WHERE id=$1")
                .bind(profile.id)
                .fetch_optional(&mut *tx)
                .await?;
        if old
            .as_ref()
            .is_some_and(|(v, code)| *v != profile.version || *code != profile.code)
            || (old.is_none() && profile.version != 0)
        {
            return Err(Error::Conflict);
        }
        profile.version += 1;
        profile.entity_id = sqlx::query_scalar("INSERT INTO attributes.industry_profiles(id,code,name,description,status,version,metadata,template) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=$3,description=$4,status=$5,version=$6,metadata=$7,template=$8,updated_at=clock_timestamp() RETURNING entity_id")
            .bind(profile.id).bind(&profile.code).bind(&profile.name).bind(&profile.description).bind(&profile.status).bind(profile.version).bind(&profile.metadata).bind(json!(profile.template)).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(profile)
    }
    pub async fn preview_industry(&self, id: Uuid) -> Result<Preview> {
        let profile = self
            .profiles()
            .await?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or(Error::NotFound)?;
        let mut tx = self.pool.begin().await?;
        let configuration: Configuration = sqlx::query_as("SELECT industry_profile_id,default_attribute_set_id,version FROM attributes.catalog_configuration WHERE singleton")
            .fetch_one(&mut *tx).await?;
        let definitions = crate::definitions(&mut tx, "product").await?;
        let defaults = unused_defaults(&mut tx, &configuration, &profile, &definitions).await?;
        let mut attributes = preview(&profile, &definitions);
        for attribute in &mut attributes {
            if defaults.iter().any(|d| d.attribute_code == attribute.code) {
                attribute.action = "configure_default".into();
                attribute.reason = Some("Unused platform default will adopt the industry's unit or source policy after confirmation".into());
            }
        }
        Ok(Preview {
            configuration,
            attributes,
            profile,
        })
    }
    pub async fn apply_industry(&self, input: Apply) -> Result<Configuration> {
        if !input.confirmed {
            return Err(bad(
                "Preview and explicitly confirm the attribute configuration",
            ));
        }
        let profile = self
            .profiles()
            .await?
            .into_iter()
            .find(|p| p.id == input.profile_id)
            .ok_or(Error::NotFound)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let current:Configuration=sqlx::query_as("SELECT industry_profile_id,default_attribute_set_id,version FROM attributes.catalog_configuration WHERE singleton FOR UPDATE").fetch_one(&mut *tx).await?;
        if current.version != input.expected_version || profile.version != input.profile_version {
            return Err(Error::Conflict);
        }
        // Recheck mutable custom profiles inside the shared write lock.
        let saved_version: Option<i32> =
            sqlx::query_scalar("SELECT version FROM attributes.industry_profiles WHERE id=$1")
                .bind(profile.id)
                .fetch_optional(&mut *tx)
                .await?;
        if saved_version.is_some_and(|v| v != profile.version) {
            return Err(Error::Conflict);
        }
        if profile.status != "active"
            || input.selected_codes.len() > 100
            || input
                .selected_codes
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != input.selected_codes.len()
            || input.selected_codes.iter().any(|c| {
                !profile
                    .template
                    .iter()
                    .any(|m| m.definition.attribute_code == *c)
            })
        {
            return Err(bad("Invalid selected profile attributes"));
        }
        let mut definitions = crate::definitions(&mut tx, "product").await?;
        // First-store setup may configure exact, unused migration defaults.
        // Recheck eligibility under the same lock as catalog/definition writes;
        // all changes roll back if any selected attribute still conflicts.
        for default in unused_defaults(&mut tx, &current, &profile, &definitions).await? {
            if input.selected_codes.contains(&default.attribute_code) {
                let saved = Self::save_in(&mut tx, default).await?;
                if let Some(existing) = definitions.iter_mut().find(|d| d.id == saved.id) {
                    *existing = saved;
                }
            }
        }
        let preview = preview(&profile, &definitions);
        if preview
            .iter()
            .any(|p| input.selected_codes.contains(&p.code) && p.action == "conflict")
        {
            return Err(bad(
                "Resolve the previewed attribute conflicts before applying",
            ));
        }
        let mut members = Vec::new();
        for (position, entry) in profile
            .template
            .iter()
            .filter(|e| input.selected_codes.contains(&e.definition.attribute_code))
            .enumerate()
        {
            let id = if let Some(existing) = definitions
                .iter()
                .find(|d| d.attribute_code == entry.definition.attribute_code)
            {
                existing.id
            } else {
                let mut d = entry.definition.clone();
                d.id = Uuid::new_v4();
                d.version = 0;
                Self::save_in(&mut tx, d).await?.id
            };
            members.push(SetMember {
                definition_id: id,
                group_name: entry.group.clone(),
                position: position as i32,
            });
        }
        let name = format!("{} Default", profile.name);
        let previous: Option<(Uuid, i32)> =
            sqlx::query_as("SELECT id,version FROM attributes.sets WHERE name=$1")
                .bind(&name)
                .fetch_optional(&mut *tx)
                .await?;
        // Never mutate a pre-existing merchant set during profile application.
        let set_id = if let Some((id, _)) = previous {
            let ids:Vec<Uuid>=sqlx::query_scalar("SELECT definition_id FROM attributes.set_members WHERE set_id=$1 ORDER BY definition_id").bind(id).fetch_all(&mut *tx).await?;
            let mut selected: Vec<Uuid> = members.iter().map(|m| m.definition_id).collect();
            selected.sort();
            if ids != selected {
                return Err(bad("A set with this name has different members; customize the set or create a separately named profile"));
            }
            id
        } else {
            Self::save_set_in(
                &mut tx,
                AttributeSet {
                    id: Uuid::new_v4(),
                    entity_id: 0,
                    name,
                    description: profile.description.clone(),
                    version: 0,
                    members,
                },
            )
            .await?
            .id
        };
        persist_template(&mut tx, &profile).await?;
        if current.industry_profile_id == Some(profile.id)
            && current.default_attribute_set_id == Some(set_id)
        {
            tx.commit().await?;
            return Ok(current);
        }
        let updated:Configuration=sqlx::query_as("UPDATE attributes.catalog_configuration SET industry_profile_id=$1,default_attribute_set_id=$2,version=version+1,updated_at=clock_timestamp() WHERE singleton RETURNING industry_profile_id,default_attribute_set_id,version")
            .bind(profile.id).bind(set_id).fetch_one(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "catalog.attribute_definition_updated",
            json!({"industry_profile_id":profile.id}),
        )
        .await?;
        tx.commit().await?;
        Ok(updated)
    }
}

/// Recognize only the two conflicting definitions from the Default-set seed.
/// Comparing every persisted field prevents silently overwriting customization.
fn pristine_default(d: &Definition) -> bool {
    let (label, kind, visible, metadata) = match d.attribute_code.as_str() {
        "weight" => (
            "Weight (kg)",
            "measurement",
            false,
            json!({"unit":"kg","min":0,"display_order":10,"ai_queryable":false}),
        ),
        "manufacturer" => (
            "Manufacturer",
            "text",
            true,
            json!({"max_length":255,"display_order":10,"ai_queryable":true}),
        ),
        _ => return false,
    };
    let expected: Definition = serde_json::from_value(json!({
        "id": d.id, "entity_id": d.entity_id, "entity_type":"product",
        "attribute_code":d.attribute_code, "label":label, "input_type":kind,
        "scope":"global", "is_required":false, "is_unique":false,
        "is_searchable":visible, "is_filterable":false, "is_comparable":false,
        "is_visible_on_front":visible, "used_for_promo_rules":false,
        "used_for_configurations":false, "swatch_type":"none", "options":[],
        "version":1, "metadata":metadata
    }))
    .expect("valid platform default definition");
    json!(d) == json!(expected)
}

async fn unused_defaults(
    tx: &mut Transaction<'_, Postgres>,
    current: &Configuration,
    profile: &IndustryProfile,
    definitions: &[Definition],
) -> Result<Vec<Definition>> {
    if current.version != 0
        || current.industry_profile_id.is_some()
        || !templates().iter().any(|p| p.id == profile.id)
    {
        return Ok(Vec::new());
    }
    let empty: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM catalog.products) AND NOT EXISTS(SELECT 1 FROM orders.orders) AND NOT EXISTS(SELECT 1 FROM attributes.industry_profiles) AND EXISTS(SELECT 1 FROM attributes.sets WHERE id=$1 AND name='Default' AND version=1 AND description='General-purpose product attributes inspired by Adobe Commerce. Core product fields are managed in the standard product editor.')")
        .bind(current.default_attribute_set_id).fetch_one(&mut **tx).await?;
    if !empty {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in &profile.template {
        let recommended = &entry.definition;
        let Some(existing) = definitions
            .iter()
            .find(|d| d.attribute_code == recommended.attribute_code)
        else {
            continue;
        };
        if compatible(existing, recommended) || !pristine_default(existing) {
            continue;
        }
        let isolated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attributes.set_members WHERE definition_id=$1 AND set_id=$2 AND position=10 AND group_name=$3) AND NOT EXISTS(SELECT 1 FROM attributes.set_members WHERE definition_id=$1 AND set_id<>$2) AND NOT EXISTS(SELECT 1 FROM attributes.value_relationships WHERE definition_id=$1 OR target_definition_id=$1) AND NOT EXISTS(SELECT 1 FROM catalog.attributes WHERE code=$4)")
            .bind(existing.id).bind(current.default_attribute_set_id)
            .bind(if existing.attribute_code == "weight" { "Shipping" } else { "General" })
            .bind(&existing.attribute_code).fetch_one(&mut **tx).await?;
        if isolated {
            let mut configured = existing.clone();
            if configured.metadata.unit != recommended.metadata.unit {
                configured.metadata.unit = recommended.metadata.unit.clone();
                configured.label = recommended.label.clone();
            }
            configured.metadata.source_policy = recommended.metadata.source_policy.clone();
            if compatible(&configured, recommended) {
                result.push(configured);
            }
        }
    }
    Ok(result)
}

fn preview(profile: &IndustryProfile, defs: &[Definition]) -> Vec<PreviewAttribute> {
    profile.template.iter().map(|entry| {let d=&entry.definition;let old=defs.iter().find(|v|v.attribute_code==d.attribute_code);let conflict=old.is_some_and(|o|!compatible(o,d));PreviewAttribute{code:d.attribute_code.clone(),label:d.label.clone(),group:entry.group.clone(),action:if conflict{"conflict"}else if old.is_some(){"reuse"}else{"create"}.into(),reason:conflict.then(||"Existing type, options, unit or source policy is incompatible; no data will be overwritten".into())}}).collect()
}
async fn persist_template(tx: &mut Transaction<'_, Postgres>, p: &IndustryProfile) -> Result<()> {
    sqlx::query("INSERT INTO attributes.industry_profiles(id,code,name,description,status,version,metadata,template) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING")
        .bind(p.id).bind(&p.code).bind(&p.name).bind(&p.description).bind(&p.status).bind(p.version).bind(&p.metadata).bind(json!(p.template)).execute(&mut **tx).await?;
    Ok(())
}
