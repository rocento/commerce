//! Explicit merchant-approved public identity and revision-bound CMS annotations.
use crate::{
    discoverability::{App, Settings, SELECT},
    identity::{self, ApiError},
};
use axum::{extract::State, http::HeaderMap, Json};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgConnection};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Configuration {
    pub published: bool,
    pub legal_name: String,
    pub description: String,
    pub logo_id: Option<Uuid>,
    pub contact_published: bool,
    pub email: String,
    pub telephone: String,
    pub locations_published: bool,
    pub country: String,
    pub region: String,
    pub locations: Vec<String>,
    pub delivery_areas: Vec<String>,
    pub social_profiles: Vec<String>,
    pub pages: Vec<Page>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub document_id: Uuid,
    pub revision_id: Uuid,
    pub purpose: String,
    pub locale: String,
    pub effective_date: Option<chrono::NaiveDate>,
    pub comparison_products: Vec<Uuid>,
}
#[derive(Serialize, FromRow)]
pub struct Stored {
    pub revision: i32,
    pub configuration: sqlx::types::Json<Configuration>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i32,
    pub configuration: Configuration,
}
#[derive(Serialize, Clone)]
pub struct PublicPage {
    pub document_id: Uuid,
    pub revision_id: Uuid,
    pub purpose: String,
    pub title: String,
    pub url: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub effective_date: Option<chrono::NaiveDate>,
}
#[derive(Serialize)]
pub struct PublicEntity {
    pub legal_name: String,
    pub description: String,
    pub logo_id: Option<Uuid>,
    pub email: String,
    pub telephone: String,
    pub country: String,
    pub region: String,
    pub locations: Vec<String>,
    pub delivery_areas: Vec<String>,
    pub social_profiles: Vec<String>,
    pub pages: Vec<PublicPage>,
}
pub const ENTITY_SELECT: &str =
    "SELECT revision,configuration FROM cms.publication_entity WHERE singleton";
const PURPOSES: [&str; 12] = [
    "shipping",
    "returns",
    "warranty",
    "payment",
    "buying-guide",
    "category-guide",
    "sizing-guide",
    "materials-guide",
    "ingredients-guide",
    "comparison",
    "faq",
    "care",
];
fn invalid() -> Error {
    Error::Invalid("Check public identity fields, HTTPS social links, page revisions, purpose, locale, effective dates and limits".into())
}
fn valid_locale(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 2 && b.iter().all(u8::is_ascii_lowercase))
        || (b.len() == 5
            && b[..2].iter().all(u8::is_ascii_lowercase)
            && b[2] == b'-'
            && b[3..].iter().all(u8::is_ascii_uppercase))
}
impl Configuration {
    pub fn validate(&self) -> Result<(), Error> {
        let strings = [
            &self.legal_name,
            &self.description,
            &self.email,
            &self.telephone,
            &self.country,
            &self.region,
        ];
        if strings
            .iter()
            .any(|s| s.len() > 1000 || s.chars().any(char::is_control))
            || self.pages.len() > 100
            || self.locations.len() > 20
            || self.delivery_areas.len() > 50
            || self.social_profiles.len() > 10
            || self
                .locations
                .iter()
                .chain(&self.delivery_areas)
                .any(|s| s.trim().is_empty() || s.len() > 300 || s.chars().any(char::is_control))
        {
            return Err(invalid());
        }
        if !self.email.is_empty()
            && (!self.email.contains('@') || self.email.contains([' ', '<', '>']))
        {
            return Err(invalid());
        }
        for link in &self.social_profiles {
            let u = reqwest::Url::parse(link).map_err(|_| invalid())?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || link.len() > 2000
            {
                return Err(invalid());
            }
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.pages {
            if !seen.insert(p.document_id)
                || !PURPOSES.contains(&p.purpose.as_str())
                || p.comparison_products.len() > 6
                || !valid_locale(&p.locale)
                || p.comparison_products
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != p.comparison_products.len()
                || (p.purpose != "comparison" && !p.comparison_products.is_empty())
                || (p.purpose == "comparison" && p.comparison_products.len() < 2)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
pub async fn read(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("discovery.read")?;
    let mut tx = a.identity.admins.pool.begin().await?;
    let stored: Stored = sqlx::query_as(ENTITY_SELECT).fetch_one(&mut *tx).await?;
    let settings: Settings = sqlx::query_as(SELECT).fetch_one(&mut *tx).await?;
    let docs: Vec<(Uuid, String, i32)> =
        sqlx::query_as("SELECT id,key,version FROM cms.documents ORDER BY key LIMIT 500")
            .fetch_all(&mut *tx)
            .await?;
    let mut document_states = vec![];
    for (id, key, version) in &docs {
        let current = current_page(&mut tx, *id).await?;
        document_states.push(json!({"id":id,"key":key,"version":version,"current_revision":current.as_ref().map(|r|r.0),"state":if current.is_some(){"PUBLISHED"}else{"UNPUBLISHED"}}));
    }
    let definitions:Vec<(String,i64,i64)>=sqlx::query_as("WITH sample AS (SELECT p.* FROM catalog.storefront_products p WHERE p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products parent WHERE parent.id=p.parent_id AND parent.active)) ORDER BY p.id LIMIT 1000) SELECT d.label,count(p.id),count(p.id) FILTER(WHERE p.attributes ? d.attribute_code AND jsonb_typeof(p.attributes->d.attribute_code) IN ('string','number','boolean') AND NOT EXISTS(SELECT 1 FROM attributes.value_provenance v WHERE v.product_id=p.id AND v.definition_id=d.id AND v.source IN ('AI_INFERRED','DERIVED')) AND p.attributes->d.attribute_code NOT IN ('null'::jsonb,'\"\"'::jsonb)) FROM attributes.definitions d LEFT JOIN sample p ON true WHERE d.entity_type='product' AND (d.is_visible_on_front OR d.used_for_configurations) AND d.input_type NOT IN ('media_image','file') AND COALESCE(d.metadata->>'status','active')='active' GROUP BY d.id,d.label ORDER BY d.label LIMIT 100").fetch_all(&mut *tx).await?;
    let industry:Option<String>=sqlx::query_scalar("SELECT p.name FROM attributes.catalog_configuration c JOIN attributes.industry_profiles p ON p.id=c.industry_profile_id WHERE c.singleton").fetch_optional(&mut *tx).await?;
    let mut warnings = vec![];
    let c = &stored.configuration.0;
    if !c.published {
        warnings.push("Merchant public profile is not published".to_string())
    }
    if c.legal_name.trim().is_empty() {
        warnings.push("Business name is missing".into())
    }
    if c.description.trim().is_empty() {
        warnings.push("Merchant description is missing".into())
    }
    if c.logo_id.is_none() {
        warnings.push("Public logo is missing".into())
    }
    if !c.contact_published || (c.email.is_empty() && c.telephone.is_empty()) {
        warnings.push("No approved public customer-service contact".into())
    }
    let mut states = vec![];
    for page in &c.pages {
        let active = current_page(&mut tx, page.document_id).await?;
        let valid = active.as_ref().is_some_and(|r| r.0 == page.revision_id)
            && page.locale == settings.default_locale;
        let policy =
            ["shipping", "returns", "warranty", "payment"].contains(&page.purpose.as_str());
        let route_live = if let Some((_, key, _, _)) = &active {
            super::canonical::resolve(&mut tx, &format!("/pages/{key}"))
                .await?
                .status
                == 200
        } else {
            false
        };
        let eligible = c.published
            && route_live
            && valid
            && (!policy
                || page
                    .effective_date
                    .is_some_and(|d| d <= chrono::Utc::now().date_naive()));
        let reason = if !c.published {
            "Publish the approved merchant profile"
        } else if active.is_none() {
            "Publish a CMS revision; this page is unpublished, expired or unavailable"
        } else if active.as_ref().is_some_and(|r| r.0 != page.revision_id) {
            "Review and approve the current published revision"
        } else if page.locale != settings.default_locale {
            "The approved locale differs from the storefront locale"
        } else if !route_live {
            "The page is redirected, removed or lacks a canonical public route"
        } else if policy && page.effective_date.is_none() {
            "Set the merchant-approved policy effective date"
        } else if policy
            && page
                .effective_date
                .is_some_and(|d| d > chrono::Utc::now().date_naive())
        {
            "The policy effective date is in the future"
        } else {
            "Current approved public revision"
        };
        states.push(json!({"document_id":page.document_id,"purpose":page.purpose,"status":if eligible{"PUBLISHED"}else{"NEEDS_REVIEW"},"reason":reason}));
    }
    for purpose in ["shipping", "returns", "warranty", "payment"] {
        if !states
            .iter()
            .any(|p| p["purpose"] == purpose && p["status"] == "PUBLISHED")
        {
            warnings.push(format!("No current approved {purpose} page with an effective date in the storefront locale"));
        }
    }
    tx.commit().await?;
    Ok(Json(
        json!({"revision":stored.revision,"locale":settings.default_locale,"configuration":stored.configuration,"warnings":warnings,"pages":states,"documents":document_states,"industry":industry,"coverage":definitions.iter().map(|(label,total,present)|json!({"label":label,"active_products":total,"with_value":present})).collect::<Vec<_>>()}),
    ))
}
pub async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Input>,
) -> Result<Json<Value>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("discovery.write")?;
    i.configuration.validate()?;
    let mut tx = a.identity.admins.pool.begin().await?;
    for page in &i.configuration.pages {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM cms.revisions WHERE id=$1 AND document_id=$2)",
        )
        .bind(page.revision_id)
        .bind(page.document_id)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(invalid().into());
        }
        for id in &page.comparison_products {
            let product = domain_catalog::public::product(&mut tx, &id.to_string()).await?;
            let Some(product) = product else {
                return Err(invalid().into());
            };
            if super::canonical::resolve(&mut tx, &format!("/products/{}", product.slug))
                .await?
                .status
                != 200
            {
                return Err(invalid().into());
            }
        }
    }
    if let Some(id) = i.configuration.logo_id {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.media WHERE id=$1 AND content_type IN ('image/png','image/jpeg','image/webp'))").bind(id).fetch_one(&mut *tx).await?;
        if !exists {
            return Err(invalid().into());
        }
    }
    let revision:Option<i32>=sqlx::query_scalar("UPDATE cms.publication_entity SET revision=revision+1,configuration=$1 WHERE singleton AND revision=$2 RETURNING revision").bind(sqlx::types::Json(&i.configuration)).bind(i.expected_revision).fetch_optional(&mut *tx).await?;
    let revision = revision.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "discovery.entity.updated",
        Uuid::from_u128(0xd15c0),
        json!({"revision":revision,"published":i.configuration.published}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":revision})))
}
type Current = (Uuid, String, String, chrono::DateTime<chrono::Utc>);
async fn current_page(db: &mut PgConnection, id: Uuid) -> Result<Option<Current>, sqlx::Error> {
    sqlx::query_as("SELECT r.id,d.key,r.title,l.starts_at FROM cms.documents d JOIN LATERAL(SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id WHERE d.id=$1 AND d.kind='page' AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp())").bind(id).fetch_optional(db).await
}
pub async fn project(
    db: &mut PgConnection,
    context: &super::canonical::Context,
    locale: &str,
) -> Result<(Option<PublicEntity>, BTreeMap<Uuid, Vec<Uuid>>), sqlx::Error> {
    let stored: Stored = sqlx::query_as(ENTITY_SELECT).fetch_one(&mut *db).await?;
    let c = stored.configuration.0;
    if !c.published {
        return Ok((None, BTreeMap::new()));
    }
    let mut pages = vec![];
    let mut comparisons = BTreeMap::new();
    for p in &c.pages {
        if p.locale != locale {
            continue;
        }
        let policy = ["shipping", "returns", "warranty", "payment"].contains(&p.purpose.as_str());
        if policy
            && p.effective_date
                .is_none_or(|d| d > chrono::Utc::now().date_naive())
        {
            continue;
        }
        if let Some((revision, key, title, updated_at)) = current_page(db, p.document_id).await? {
            if revision != p.revision_id {
                continue;
            }
            let path = format!("/pages/{key}");
            if super::canonical::resolve(db, &path).await?.status != 200 {
                continue;
            }
            if let Some(identity) = context.resource(&path, 1) {
                pages.push(PublicPage {
                    document_id: p.document_id,
                    revision_id: revision,
                    purpose: p.purpose.clone(),
                    title,
                    url: identity.url,
                    updated_at,
                    effective_date: p.effective_date,
                });
                comparisons.insert(p.document_id, p.comparison_products.clone());
            }
        }
    }
    Ok((
        Some(PublicEntity {
            legal_name: c.legal_name,
            description: c.description,
            logo_id: c.logo_id,
            email: if c.contact_published {
                c.email
            } else {
                String::new()
            },
            telephone: if c.contact_published {
                c.telephone
            } else {
                String::new()
            },
            country: c.country,
            region: c.region,
            locations: if c.locations_published {
                c.locations
            } else {
                vec![]
            },
            delivery_areas: c.delivery_areas,
            social_profiles: c.social_profiles,
            pages,
        }),
        comparisons,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_explicit_public_profile_without_guessing_contacts() {
        let mut c = Configuration::default();
        assert!(c.validate().is_ok());
        c.social_profiles = vec!["javascript:alert(1)".into()];
        assert!(c.validate().is_err());
        c.social_profiles = vec!["https://name:secret@example.test/".into()];
        assert!(c.validate().is_err());
        c.social_profiles.clear();
        c.email = "public@example.test\nprivate".into();
        assert!(c.validate().is_err());
        assert!(
            serde_json::from_value::<Configuration>(json!({"admin_password":"secret"})).is_err()
        );
    }
}
