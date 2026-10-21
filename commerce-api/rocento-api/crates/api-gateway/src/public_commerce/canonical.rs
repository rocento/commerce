//! Trusted canonical identity shared by document and future structured-data/discovery adapters.
use super::policy::{production_origin, Deployment};
use crate::discoverability::Settings;
use serde::Serialize;
use sqlx::PgConnection;
use uuid::Uuid;

pub struct Context {
    origin: String,
    locale: String,
    installation_id: Uuid,
}
#[derive(Debug, Serialize)]
pub struct Identity {
    pub installation_id: Uuid,
    pub locale: String,
    pub path: String,
    pub url: String,
    pub html: String,
    pub json_ld: String,
    pub sitemap: String,
    pub feed: String,
}
impl Context {
    pub fn from_installation(
        deployment: &Deployment,
        settings: &Settings,
        database_id: Uuid,
    ) -> Option<Self> {
        if deployment.environment != "production" || deployment.installation_id != Some(database_id)
        {
            return None;
        }
        let origin = production_origin(settings.canonical_url.as_deref()?)?;
        if deployment.approved_origin.as_ref() != Some(&origin) {
            return None;
        }
        Some(Self {
            origin,
            locale: settings.default_locale.clone(),
            installation_id: database_id,
        })
    }
    pub fn resource(&self, path: &str, page: u32) -> Option<Identity> {
        if !super::snapshot::valid_path(path) || page == 0 || page > 10000 {
            return None;
        }
        if page > 1 && path != "/" && !path.starts_with("/categories/") {
            return None;
        }
        let path = if page > 1 {
            format!("{path}?page={page}")
        } else {
            path.to_owned()
        };
        let url = format!("{}{}", self.origin.trim_end_matches('/'), path);
        Some(Identity {
            installation_id: self.installation_id,
            locale: self.locale.clone(),
            path,
            url: url.clone(),
            html: url.clone(),
            json_ld: url.clone(),
            sitemap: url.clone(),
            feed: url,
        })
    }
}

pub struct Route {
    pub status: u16,
    pub path: Option<String>,
}
/// Resolve aliases by stable resource ID. Follow explicit replacements only within this installation.
pub async fn resolve(db: &mut PgConnection, requested: &str) -> Result<Route, sqlx::Error> {
    let mut path = requested.to_owned();
    let mut visited = std::collections::HashSet::new();
    for _ in 0..16 {
        if !visited.insert(path.clone()) {
            tracing::warn!(event = "publication_response", code = "redirect_loop");
            break;
        }
        if !super::snapshot::valid_path(&path) {
            break;
        }
        let decision: Option<(i32, Option<String>)> =
            sqlx::query_as("SELECT status,target FROM platform.publication_routes WHERE path=$1")
                .bind(&path)
                .fetch_optional(&mut *db)
                .await?;
        match decision {
            Some((410, _)) => {
                return Ok(Route {
                    status: 410,
                    path: None,
                })
            }
            Some((301, Some(target))) => {
                path = target;
                continue;
            }
            Some(_) => break,
            None => {}
        }
        let current = live_path(db, &path).await?;
        match current {
            Some(current) if current != path => {
                path = current;
            }
            Some(current) => {
                return Ok(Route {
                    status: if requested == current { 200 } else { 301 },
                    path: Some(current),
                })
            }
            None => break,
        }
    }
    Ok(Route {
        status: 404,
        path: None,
    })
}
async fn live_path(db: &mut PgConnection, path: &str) -> Result<Option<String>, sqlx::Error> {
    if path == "/" {
        return Ok(Some("/".into()));
    }
    if let Some(key) = path.strip_prefix("/products/") {
        let slug:Option<String>=sqlx::query_scalar("SELECT p.slug FROM platform.publication_aliases a JOIN catalog.storefront_products p ON p.id=a.resource_id WHERE a.resource_kind='products' AND a.route_key=$1 AND p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products parent WHERE parent.id=p.parent_id AND parent.active))").bind(key).fetch_optional(db).await?;
        return Ok(slug.map(|slug| format!("/products/{slug}")));
    }
    if let Some(key) = path.strip_prefix("/categories/") {
        let slug:Option<String>=sqlx::query_scalar("SELECT c.slug FROM platform.publication_aliases a JOIN catalog.storefront_categories c ON c.id=a.resource_id WHERE a.resource_kind='categories' AND a.route_key=$1").bind(key).fetch_optional(db).await?;
        return Ok(slug.map(|slug| format!("/categories/{slug}")));
    }
    if let Some(key) = path.strip_prefix("/pages/") {
        let visible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cms.documents d JOIN LATERAL (SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id WHERE d.key=$1 AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp()))").bind(key).fetch_one(db).await?;
        return Ok(visible.then(|| path.to_owned()));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adapters_share_one_identity_and_pagination_cannot_change_origin() {
        let context = Context {
            origin: "https://merchant.example/".into(),
            locale: "ar".into(),
            installation_id: Uuid::new_v4(),
        };
        let identity = context.resource("/categories/fresh-fruit", 2).unwrap();
        assert_eq!(
            identity.url,
            "https://merchant.example/categories/fresh-fruit?page=2"
        );
        assert_eq!(identity.html, identity.json_ld);
        assert_eq!(identity.html, identity.sitemap);
        assert_eq!(identity.html, identity.feed);
        assert_eq!(identity.locale, "ar");
        for path in [
            "//other.example/products/apple",
            "https://other.example/",
            "/ar/products/apple",
            "/products/a?host=other.example",
        ] {
            assert!(context.resource(path, 1).is_none());
        }
        assert!(context.resource("/products/apple", 2).is_none());
    }
}
