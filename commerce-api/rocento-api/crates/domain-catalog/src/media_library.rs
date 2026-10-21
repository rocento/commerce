//! Logical media folders preserve media IDs and object keys used by storefronts.
use super::{invalid, Media, Service};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct MediaFolder {
    pub id: Uuid,
    pub entity_id: i64,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub media_count: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderInput {
    pub name: String,
    pub parent_id: Option<Uuid>,
}
#[derive(Debug, Serialize, FromRow)]
pub struct LibraryMedia {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub media: Media,
    pub folder_id: Option<Uuid>,
    pub file_name: String,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct LibraryQuery {
    pub folder: Option<String>,
    pub q: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}
#[derive(Serialize)]
pub struct LibraryPage {
    pub items: Vec<LibraryMedia>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveMediaInput {
    pub ids: Vec<Uuid>,
    pub folder_id: Option<Uuid>,
}
fn folder_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(invalid(
            "Use a folder name of 1–100 characters without slashes or control characters",
        ));
    }
    Ok(name.into())
}
impl Service {
    pub async fn media_folders(&self) -> Result<Vec<MediaFolder>> {
        Ok(sqlx::query_as("SELECT f.id,f.entity_id,f.name,f.parent_id,count(m.id)::bigint AS media_count FROM catalog.media_folders f LEFT JOIN catalog.media m ON m.folder_id=f.id GROUP BY f.id ORDER BY lower(f.name),f.id").fetch_all(&self.pool).await?)
    }
    pub async fn save_media_folder(
        &self,
        id: Option<Uuid>,
        input: FolderInput,
    ) -> Result<MediaFolder> {
        let name = folder_name(&input.name)?;
        let mut tx = self.transaction().await?;
        if let Some(id) = id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.media_folders WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
        }
        if let Some(parent) = input.parent_id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.media_folders WHERE id=$1)",
            )
            .bind(parent)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(invalid("Destination folder does not exist"));
            }
            if let Some(id) = id {
                let cycle: bool = sqlx::query_scalar("WITH RECURSIVE subtree AS (SELECT id FROM catalog.media_folders WHERE id=$1 UNION ALL SELECT f.id FROM catalog.media_folders f JOIN subtree s ON f.parent_id=s.id) SELECT EXISTS(SELECT 1 FROM subtree WHERE id=$2)").bind(id).bind(parent).fetch_one(&mut *tx).await?;
                if cycle {
                    return Err(invalid(
                        "A folder cannot be moved inside itself or its subfolders",
                    ));
                }
            }
        }
        let actual = id.unwrap_or_else(Uuid::new_v4);
        let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.media_folders WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name)=lower($2) AND id<>$3)").bind(input.parent_id).bind(&name).bind(actual).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(invalid("A folder with this name already exists here"));
        }
        let entity_id = sqlx::query_scalar("INSERT INTO catalog.media_folders(id,name,parent_id) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,parent_id=$3 RETURNING entity_id").bind(actual).bind(&name).bind(input.parent_id).fetch_one(&mut *tx).await?;
        let media_count =
            sqlx::query_scalar("SELECT count(*) FROM catalog.media WHERE folder_id=$1")
                .bind(actual)
                .fetch_one(&mut *tx)
                .await?;
        Self::changed(&mut tx, "catalog.media_folder_saved", actual).await?;
        tx.commit().await?;
        Ok(MediaFolder {
            id: actual,
            entity_id,
            name,
            parent_id: input.parent_id,
            media_count,
        })
    }
    /// Cascading folder removal detaches files into Unfiled, never deleting media.
    pub async fn delete_media_folder(&self, id: Uuid) -> Result<()> {
        let mut tx = self.transaction().await?;
        let count = sqlx::query("DELETE FROM catalog.media_folders WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if count == 0 {
            return Err(Error::NotFound);
        }
        Self::changed(&mut tx, "catalog.media_folder_deleted", id).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn media_library(&self, query: LibraryQuery) -> Result<LibraryPage> {
        let folder = query.folder.as_deref().unwrap_or("all");
        let all = folder == "all";
        let folder_id = if all || folder == "unfiled" {
            None
        } else {
            Some(Uuid::parse_str(folder).map_err(|_| invalid("Invalid folder"))?)
        };
        let q = query.q.unwrap_or_default();
        let offset = query.offset.unwrap_or(0);
        let limit = query.limit.unwrap_or(48);
        if q.chars().count() > 200 || offset < 0 || !(1..=100).contains(&limit) {
            return Err(invalid("Invalid media search or page size"));
        }
        let q = format!(
            "%{}%",
            q.trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let total = sqlx::query_scalar("SELECT count(*) FROM catalog.media WHERE ($1 OR folder_id IS NOT DISTINCT FROM $2) AND (alt ILIKE $3 OR file_name ILIKE $3)").bind(all).bind(folder_id).bind(&q).fetch_one(&self.pool).await?;
        let items = sqlx::query_as("SELECT id,entity_id,content_type,alt,object_key,size_bytes,folder_id,file_name FROM catalog.media WHERE ($1 OR folder_id IS NOT DISTINCT FROM $2) AND (alt ILIKE $3 OR file_name ILIKE $3) ORDER BY created_at DESC,id LIMIT $4 OFFSET $5").bind(all).bind(folder_id).bind(&q).bind(limit).bind(offset).fetch_all(&self.pool).await?;
        Ok(LibraryPage {
            items,
            total,
            offset,
            limit,
        })
    }
    pub async fn move_media(&self, input: MoveMediaInput) -> Result<()> {
        let mut ids = input.ids;
        ids.sort();
        ids.dedup();
        if ids.is_empty() || ids.len() > 500 {
            return Err(invalid("Select between 1 and 500 images"));
        }
        let mut tx = self.transaction().await?;
        if let Some(folder) = input.folder_id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.media_folders WHERE id=$1)",
            )
            .bind(folder)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(invalid("Destination folder does not exist"));
            }
        }
        let count = sqlx::query("UPDATE catalog.media SET folder_id=$2 WHERE id=ANY($1)")
            .bind(&ids)
            .bind(input.folder_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if count != ids.len() as u64 {
            return Err(Error::NotFound);
        }
        for id in ids {
            Self::changed(&mut tx, "catalog.media_moved", id).await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn add_media_to_folder(
        &self,
        media: Media,
        folder_id: Option<Uuid>,
        file_name: String,
    ) -> Result<Media> {
        super::text(&media.alt, 300)?;
        let name = file_name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .take(255)
            .collect::<String>();
        let mut tx = self.transaction().await?;
        if let Some(folder) = folder_id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.media_folders WHERE id=$1)",
            )
            .bind(folder)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(invalid("Upload folder does not exist"));
            }
        }
        let media: Media = sqlx::query_as("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes,folder_id,file_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,entity_id,content_type,alt,object_key,size_bytes").bind(media.id).bind(&media.content_type).bind(&media.alt).bind(&media.object_key).bind(media.size_bytes).bind(folder_id).bind(name).fetch_one(&mut *tx).await?;
        Self::changed(&mut tx, "catalog.media_created", media.id).await?;
        tx.commit().await?;
        Ok(media)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_folder_names() {
        for name in ["", " ", ".", "..", "a/b", "a\\b", "a\nb"] {
            assert!(folder_name(name).is_err());
        }
        assert!(folder_name(&"a".repeat(101)).is_err());
        assert_eq!(
            folder_name("  Summer collection  ").unwrap(),
            "Summer collection"
        );
        assert_eq!(folder_name("صور المنتجات").unwrap(), "صور المنتجات");
        assert!(folder_name(&"ص".repeat(100)).is_ok());
        assert!(folder_name(&"ص".repeat(101)).is_err());
    }
}
