//! One resolver for anonymous HTML and authenticated merchant preview.
use super::snapshot::{self, Snapshot};
use crate::{
    discoverability::App,
    identity::{self, ApiError},
};
use axum::{extract::State, http::HeaderMap, Json};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Text {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    #[serde(default)]
    pub templates: BTreeMap<String, Text>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Text>,
    pub social_image: Option<Uuid>,
}
#[derive(Serialize, FromRow)]
pub struct Settings {
    pub revision: i32,
    pub configuration: sqlx::types::Json<Configuration>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i32,
    pub configuration: Configuration,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preview {
    pub path: String,
    #[serde(default = "first")]
    pub page: u32,
    pub configuration: Configuration,
}
fn first() -> u32 {
    1
}
#[derive(Default, Serialize)]
pub struct Resolved {
    pub title: String,
    pub description: String,
    pub image: Option<Uuid>,
    pub warnings: Vec<String>,
}
pub const SELECT: &str =
    "SELECT revision,configuration FROM cms.publication_metadata WHERE singleton";
const TOKENS: [&str; 7] = [
    "page_name",
    "product_name",
    "category_name",
    "content_title",
    "merchant_name",
    "description",
    "default_description",
];
fn invalid() -> Error {
    Error::Invalid("Use known page types, resource IDs and template tokens; text must be at most 2000 characters without controls".into())
}
impl Configuration {
    pub fn validate(&self) -> Result<(), Error> {
        if self.overrides.len() > 500 {
            return Err(invalid());
        }
        for (key, text) in &self.templates {
            if !["home", "product", "category", "content"].contains(&key.as_str()) {
                return Err(invalid());
            }
            for value in [&text.title, &text.description] {
                let mut remainder = value.clone();
                for token in TOKENS {
                    remainder = remainder.replace(&format!("{{{token}}}"), "");
                }
                if remainder.contains(['{', '}']) {
                    return Err(invalid());
                }
            }
        }
        for key in self.overrides.keys() {
            let Some((kind, id)) = key.split_once(':') else {
                return Err(invalid());
            };
            if !["product", "category", "content"].contains(&kind) || Uuid::parse_str(id).is_err() {
                return Err(invalid());
            }
        }
        for text in self.templates.values().chain(self.overrides.values()) {
            for value in [&text.title, &text.description] {
                if value.chars().count() > 2000 || value.chars().any(char::is_control) {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
}
// Single-pass expansion: merchant data containing braces is never reinterpreted as a template.
fn expand(template: &str, values: &[(&str, &str)]) -> String {
    let mut result = String::new();
    let mut tail = template;
    while let Some(start) = tail.find('{') {
        result.push_str(&tail[..start]);
        tail = &tail[start + 1..];
        if let Some(end) = tail.find('}') {
            let key = &tail[..end];
            result.push_str(
                values
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| *v)
                    .unwrap_or(""),
            );
            tail = &tail[end + 1..];
        } else {
            result.push('{');
            break;
        }
    }
    result.push_str(tail);
    result.trim().to_owned()
}
pub fn resolve(s: &Snapshot, c: &Configuration) -> Resolved {
    if matches!(s.status, 404 | 410) {
        return Resolved {
            title: if s.status == 410 {
                "Page permanently removed"
            } else {
                "Page not found"
            }
            .into(),
            ..Default::default()
        };
    }
    let category = s.categories.iter().find(|c| Some(c.id) == s.category_id);
    let name = s
        .product
        .as_ref()
        .map(|p| p.name.as_str())
        .or_else(|| {
            s.content
                .as_ref()
                .filter(|_| s.kind == "content")
                .map(|c| c.title.as_str())
        })
        .or_else(|| category.map(|c| c.name.as_str()))
        .unwrap_or(&s.site_name);
    let cms_description = s
        .content
        .as_ref()
        .and_then(|c| c.blocks.iter().find(|b| !b.text.trim().is_empty()))
        .map(|b| b.text.as_str());
    let description = s
        .product
        .as_ref()
        .map(|p| p.description.as_str())
        .or_else(|| category.map(|c| c.description.as_str()))
        .or(cms_description)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&s.description);
    let id = s
        .product
        .as_ref()
        .map(|p| p.id)
        .or(s.category_id)
        .or_else(|| s.content.as_ref().map(|c| c.id));
    let over = id.and_then(|id| c.overrides.get(&format!("{}:{id}", s.kind)));
    let template = c.templates.get(s.kind);
    let values = [
        ("page_name", name),
        (
            "product_name",
            s.product.as_ref().map(|p| p.name.as_str()).unwrap_or(""),
        ),
        (
            "category_name",
            category.map(|c| c.name.as_str()).unwrap_or(""),
        ),
        (
            "content_title",
            s.content.as_ref().map(|c| c.title.as_str()).unwrap_or(""),
        ),
        ("merchant_name", s.site_name.as_str()),
        ("description", description),
        ("default_description", s.description.as_str()),
    ];
    let default_title = if s.kind == "home" {
        s.site_name.clone()
    } else {
        format!("{name} | {}", s.site_name)
    };
    let value = |field: fn(&Text) -> &String, fallback: &str| {
        over.map(field)
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_owned())
            .or_else(|| {
                template
                    .map(field)
                    .map(|v| expand(v, &values))
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or_else(|| fallback.to_owned())
    };
    let mut title = value(|t| &t.title, &default_title);
    if s.page > 1 {
        title.push_str(&format!(" | Page {}", s.page));
    }
    let description = value(|t| &t.description, description);
    let mut warnings = vec![];
    if title.chars().count() > 60 {
        warnings.push("Title exceeds 60 characters; preview display may shorten it. Stored text is preserved.".into());
    }
    if description.chars().count() > 160 {
        warnings.push("Description exceeds 160 characters; preview display may shorten it. Stored text is preserved.".into());
    }
    if description.is_empty() {
        warnings.push("Add a factual description; none is available.".into());
    }
    let image = s
        .product
        .as_ref()
        .and_then(|p| p.image_id)
        .into_iter()
        .chain(category.and_then(|c| c.thumbnail))
        .chain(
            s.content
                .iter()
                .flat_map(|c| c.blocks.iter().filter_map(|b| b.image_id)),
        )
        .chain(c.social_image)
        .find(|id| s.images.contains_key(id));
    Resolved {
        title,
        description,
        image,
        warnings,
    }
}
async fn authorize(
    a: &App,
    h: &HeaderMap,
    permission: &str,
) -> Result<domain_admin_iam::Identity, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(permission)?;
    Ok(who)
}
pub async fn read(State(a): State<App>, h: HeaderMap) -> Result<Json<Settings>, ApiError> {
    authorize(&a, &h, "discovery.read").await?;
    Ok(Json(
        sqlx::query_as(SELECT)
            .fetch_one(&a.identity.admins.pool)
            .await?,
    ))
}
pub async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Input>,
) -> Result<Json<Settings>, ApiError> {
    let who = authorize(&a, &h, "discovery.write").await?;
    i.configuration.validate()?;
    let mut tx = a.identity.admins.pool.begin().await?;
    validate_resources(&mut tx, &i.configuration).await?;
    let saved:Settings=sqlx::query_as("UPDATE cms.publication_metadata SET revision=revision+1,configuration=$1,updated_by=$2,updated_at=clock_timestamp() WHERE singleton AND revision=$3 RETURNING revision,configuration").bind(sqlx::types::Json(i.configuration)).bind(who.user.id).bind(i.expected_revision).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "discovery.metadata.updated",
        Uuid::from_u128(0xd15c1),
        serde_json::json!({"revision":saved.revision}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}
async fn validate_resources(
    db: &mut sqlx::PgConnection,
    c: &Configuration,
) -> Result<(), ApiError> {
    if let Some(id) = c.social_image {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.media m JOIN catalog.publication_images i ON i.media_id=m.id WHERE m.id=$1)").bind(id).fetch_one(&mut *db).await?;
        if !exists {
            return Err(Error::Invalid(
                "Select a processed image from this installation's media library".into(),
            )
            .into());
        }
    }
    for key in c.overrides.keys() {
        let (kind, id) = key.split_once(':').unwrap();
        let table = match kind {
            "product" => "catalog.products",
            "category" => "catalog.categories",
            _ => "cms.documents",
        };
        let exists: bool =
            sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1)"))
                .bind(Uuid::parse_str(id).unwrap())
                .fetch_one(&mut *db)
                .await?;
        if !exists {
            return Err(Error::Invalid(
                "Override resource does not exist in this installation".into(),
            )
            .into());
        }
    }
    Ok(())
}
pub async fn preview(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Preview>,
) -> Result<Json<Snapshot>, ApiError> {
    authorize(&a, &h, "discovery.read").await?;
    i.configuration.validate()?;
    if !snapshot::valid_path(&i.path) || i.page == 0 || i.page > 10000 {
        return Err(invalid().into());
    }
    Ok(Json(
        snapshot::assemble(
            &a,
            snapshot::Request {
                path: i.path,
                page: i.page,
            },
            Some(i.configuration),
        )
        .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expansion_is_single_pass_and_preserves_unicode() {
        assert_eq!(
            expand(
                "{page_name} | {merchant_name}",
                &[
                    ("page_name", "تفاح {merchant_name}"),
                    ("merchant_name", "café")
                ]
            ),
            "تفاح {merchant_name} | café"
        );
    }
    #[test]
    fn rejects_unknown_tokens_but_literal_override_braces_are_data() {
        let mut config = Configuration::default();
        config.templates.insert(
            "product".into(),
            Text {
                title: "{unknown}".into(),
                description: String::new(),
            },
        );
        assert!(config.validate().is_err());
        config.templates.clear();
        config.overrides.insert(
            format!("product:{}", Uuid::nil()),
            Text {
                title: "تفاح {literal}".into(),
                description: String::new(),
            },
        );
        assert!(config.validate().is_ok());
    }
}
