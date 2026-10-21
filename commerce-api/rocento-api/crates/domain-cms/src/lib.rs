//! Immutable structured revisions and time-based releases. Drafts never leak to public reads.
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub kind: String,
    pub heading: String,
    pub text: String,
    pub image_id: Option<Uuid>,
    pub link_label: String,
    pub link_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation: Option<Navigation>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Navigation {
    pub icon: String,
    pub badge: String,
    pub enabled: bool,
    pub new_tab: bool,
    pub columns: u8,
    pub links: Vec<NavigationLink>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NavigationLink {
    pub label: String,
    pub url: String,
    pub group: String,
    pub icon: String,
    pub description: String,
    pub new_tab: bool,
}
fn valid_navigation_url(url: &str) -> bool {
    !url.is_empty()
        && safe_link(url)
        && !url.chars().any(char::is_whitespace)
        && (!url.starts_with("https://")
            || url[8..]
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|host| !host.is_empty()))
}
fn valid_navigation(n: &Navigation) -> bool {
    n.icon.chars().count() <= 8
        && n.badge.len() <= 40
        && (1..=4).contains(&n.columns)
        && n.links.len() <= 40
        && n.links.iter().all(|l| {
            !l.label.trim().is_empty()
                && l.label.len() <= 100
                && !l.url.is_empty()
                && l.url.len() <= 2000
                && valid_navigation_url(&l.url)
                && l.group.len() <= 100
                && l.icon.chars().count() <= 8
                && l.description.len() <= 200
        })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub key: String,
    pub kind: String,
    pub expected_version: i32,
    pub title: String,
    pub blocks: Vec<Block>,
}
#[derive(Serialize, FromRow)]
pub struct Document {
    pub id: Uuid,
    pub entity_id: i64,
    pub key: String,
    pub kind: String,
    pub version: i32,
    pub updated_at: DateTime<Utc>,
}
#[derive(Serialize, FromRow)]
pub struct Revision {
    pub id: Uuid,
    pub entity_id: i64,
    pub document_id: Uuid,
    pub version: i32,
    pub title: String,
    pub blocks: Value,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, FromRow)]
pub struct Release {
    pub id: Uuid,
    pub entity_id: i64,
    pub document_id: Uuid,
    pub revision_id: Option<Uuid>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: Option<DateTime<Utc>>,
    pub cancelled: bool,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct Detail {
    pub document: Document,
    pub revisions: Vec<Revision>,
    pub releases: Vec<Release>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publish {
    pub revision_id: Option<Uuid>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, FromRow)]
pub struct Published {
    pub key: String,
    pub title: String,
    pub blocks: Value,
    pub version: i32,
}
fn invalid() -> Error {
    Error::Invalid(
        "Check content key, title, blocks and links. Links must be local paths or https URLs."
            .into(),
    )
}
fn safe_link(s: &str) -> bool {
    s.is_empty()
        || ((!s.contains(['\\', '\n', '\r']) && !s.chars().any(char::is_control))
            && ((s.starts_with('/') && !s.starts_with("//")) || s.starts_with("https://")))
}
impl Service {
    pub async fn list(&self) -> Result<Vec<Document>> {
        Ok(
            sqlx::query_as("SELECT * FROM cms.documents ORDER BY kind,key LIMIT 500")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn detail(&self, id: Uuid) -> Result<Detail> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let document = sqlx::query_as("SELECT * FROM cms.documents WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let revisions = sqlx::query_as(
            "SELECT * FROM cms.revisions WHERE document_id=$1 ORDER BY version DESC LIMIT 50",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        let releases=sqlx::query_as("SELECT * FROM cms.releases WHERE document_id=$1 ORDER BY starts_at DESC,created_at DESC LIMIT 100").bind(id).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(Detail {
            document,
            revisions,
            releases,
        })
    }
    pub async fn save(&self, i: Input, who: &domain_admin_iam::Identity) -> Result<Revision> {
        who.require("cms.write")?;
        if i.key.is_empty()
            || i.key.len() > 100
            || !i
                .key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !["home", "page", "footer", "navigation"].contains(&i.kind.as_str())
            || (i.kind == "home" && i.key != "home")
            || (i.kind == "footer" && i.key != "footer")
            || (i.kind == "navigation" && i.key != "navigation")
            || (i.kind == "page" && ["home", "footer", "navigation"].contains(&i.key.as_str()))
            || i.title.trim().is_empty()
            || i.title.len() > 200
            || i.blocks.len() > 30
            || i.blocks.iter().any(|b| {
                !["hero", "text", "link"].contains(&b.kind.as_str())
                    || (i.kind == "navigation"
                        && (b.kind != "link"
                            || b.link_label.trim().is_empty()
                            || b.navigation.is_none()
                            || !valid_navigation_url(&b.link_url)))
                    || (i.kind != "navigation" && b.navigation.is_some())
                    || b.navigation.as_ref().is_some_and(|n| !valid_navigation(n))
                    || b.heading.len() > 200
                    || b.text.len() > 10000
                    || b.link_label.len() > 100
                    || b.link_url.len() > 2000
                    || !safe_link(&b.link_url)
                    || (!b.link_url.is_empty() && b.link_label.trim().is_empty())
            })
        {
            return Err(invalid());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7007)")
            .execute(&mut *tx)
            .await?;
        let existing: Option<Document> = sqlx::query_as("SELECT * FROM cms.documents WHERE key=$1")
            .bind(&i.key)
            .fetch_optional(&mut *tx)
            .await?;
        let id = if let Some(d) = existing {
            if d.version != i.expected_version || d.kind != i.kind {
                return Err(Error::Conflict);
            }
            d.id
        } else {
            if i.expected_version != 0 {
                return Err(Error::Conflict);
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM cms.documents")
                .fetch_one(&mut *tx)
                .await?;
            if count >= 500 {
                return Err(Error::Invalid("At most 500 documents are supported".into()));
            }
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO cms.documents(id,key,kind) VALUES($1,$2,$3)")
                .bind(id)
                .bind(&i.key)
                .bind(&i.kind)
                .execute(&mut *tx)
                .await?;
            id
        };
        if i.expected_version >= 200 {
            return Err(Error::Invalid(
                "At most 200 revisions per document are supported".into(),
            ));
        }
        let r:Revision=sqlx::query_as("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *").bind(Uuid::new_v4()).bind(id).bind(i.expected_version+1).bind(i.title.trim()).bind(json!(i.blocks)).bind(who.user.id).fetch_one(&mut *tx).await?;
        for b in &i.blocks {
            if let Some(media) = b.image_id {
                sqlx::query("INSERT INTO cms.revision_media(revision_id,media_id) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(r.id).bind(media).execute(&mut *tx).await?;
            }
        }
        sqlx::query("UPDATE cms.documents SET version=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(id)
            .bind(r.version)
            .execute(&mut *tx)
            .await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.cms.draft_saved",
            id,
            json!({"revision_id":r.id,"version":r.version,"key":i.key}),
        )
        .await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn publish(
        &self,
        id: Uuid,
        i: Publish,
        who: &domain_admin_iam::Identity,
    ) -> Result<Release> {
        who.require("cms.publish")?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7007)")
            .execute(&mut *tx)
            .await?;
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&mut *tx)
            .await?;
        let start = i.starts_at.unwrap_or(now);
        if i.ends_at.is_some_and(|e| e <= start || e <= now) {
            return Err(Error::Invalid(
                "Unpublish time must follow publication and be in the future".into(),
            ));
        }
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cms.documents WHERE id=$1)")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(Error::NotFound);
        }
        if let Some(rev) = i.revision_id {
            let matches: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM cms.revisions WHERE id=$1 AND document_id=$2)",
            )
            .bind(rev)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if !matches {
                return Err(Error::NotFound);
            }
        }
        sqlx::query("UPDATE cms.releases SET cancelled=true WHERE document_id=$1 AND starts_at>$2 AND NOT cancelled").bind(id).bind(now).execute(&mut *tx).await?;
        let r:Release=sqlx::query_as("INSERT INTO cms.releases(id,document_id,revision_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5) RETURNING *").bind(Uuid::new_v4()).bind(id).bind(i.revision_id).bind(start.max(now)).bind(i.ends_at).fetch_one(&mut *tx).await?;
        // Only reviewed translations of this exact revision belong to the release.
        sqlx::query("INSERT INTO cms.navigation_release_translations(release_id,locale,fields) SELECT $1,t.locale,t.fields FROM cms.catalog_translations t JOIN cms.documents d ON d.id=t.entity_id JOIN cms.revisions r ON r.document_id=d.id AND r.id=$2 WHERE d.kind='navigation' AND t.entity_type='navigation' AND t.reviewed AND t.source=cms.navigation_translation_source(r.title,r.blocks,r.version)")
            .bind(r.id).bind(i.revision_id).execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.cms.release_scheduled",
            id,
            json!(r),
        )
        .await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn published(&self, key: &str) -> Result<Option<Published>> {
        self.published_localized(key, None).await
    }
    pub async fn published_localized(
        &self,
        key: &str,
        locale: Option<&str>,
    ) -> Result<Option<Published>> {
        let row: Option<(String, String, Value, i32, Option<Value>)> = sqlx::query_as(
            "SELECT d.key,r.title,r.blocks,r.version,t.fields FROM cms.documents d JOIN LATERAL (SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=statement_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id LEFT JOIN cms.navigation_release_translations t ON t.release_id=l.id AND t.locale=$2 AND d.kind='navigation' WHERE d.key=$1 AND cms.market_content_available(d.id) AND (l.ends_at IS NULL OR l.ends_at>statement_timestamp())"
        ).bind(key).bind(locale).fetch_optional(&self.pool).await?;
        Ok(row.map(|(key, title, blocks, version, fields)| {
            let mut content = Published {
                key,
                title,
                blocks,
                version,
            };
            if let Some(fields) = fields {
                translate_navigation(&mut content, &fields);
            }
            content
        }))
    }
}

fn translate_navigation(content: &mut Published, fields: &Value) {
    fn translated(target: &mut Value, key: &str, fields: &Value) {
        if let Some(value) = fields
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            *target = json!(value);
        }
    }
    if let Some(title) = fields
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        content.title = title.to_owned();
    }
    if let Some(blocks) = content.blocks.as_array_mut() {
        for (i, block) in blocks.iter_mut().enumerate() {
            translated(&mut block["link_label"], &format!("item.{i}.label"), fields);
            if let Some(nav) = block.get_mut("navigation").filter(|n| n.is_object()) {
                translated(&mut nav["badge"], &format!("item.{i}.badge"), fields);
                if let Some(links) = nav.get_mut("links").and_then(Value::as_array_mut) {
                    for (j, link) in links.iter_mut().enumerate() {
                        for field in ["label", "group", "description"] {
                            translated(
                                &mut link[field],
                                &format!("item.{i}.link.{j}.{field}"),
                                fields,
                            );
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;
    fn navigation() -> Navigation {
        Navigation {
            icon: "🛍".into(),
            badge: "New".into(),
            enabled: true,
            new_tab: false,
            columns: 3,
            links: vec![NavigationLink {
                label: "Fruit".into(),
                url: "/categories/fruit".into(),
                group: "Fresh".into(),
                icon: "🍎".into(),
                description: "Seasonal produce".into(),
                new_tab: false,
            }],
        }
    }
    #[test]
    fn validates_navigation_limits_and_destinations() {
        let mut n = navigation();
        assert!(valid_navigation(&n));
        for url in [
            "javascript:alert(1)",
            "//evil.example",
            "/\\evil.example",
            "https://example.com\n",
        ] {
            n.links[0].url = url.into();
            assert!(!valid_navigation(&n), "{url}");
        }
        n.links[0].url = "https://example.com/help".into();
        assert!(valid_navigation(&n));
        n.columns = 5;
        assert!(!valid_navigation(&n));
        n.columns = 1;
        n.links[0].label = " ".into();
        assert!(!valid_navigation(&n));
        n.links[0].label = "Link".into();
        n.links = vec![n.links[0].clone(); 41];
        assert!(!valid_navigation(&n));
    }
    #[test]
    fn old_blocks_remain_compatible() {
        let block: Block = serde_json::from_value(json!({"kind":"link","heading":"","text":"","image_id":null,"link_label":"Home","link_url":"/"})).unwrap();
        assert!(block.navigation.is_none());
        assert!(serde_json::to_value(block)
            .unwrap()
            .get("navigation")
            .is_none());
    }
}
