//! Merchant-owned logical folders. All writes serialize with membership changes.
use crate::{
    service::{Access, Service},
    studio::Asset,
    *,
};

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetFolder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub asset_count: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFolder {
    pub name: String,
    pub parent_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAssets {
    pub ids: Vec<Uuid>,
    pub folder_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameAsset {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryQuery {
    pub environment: Environment,
    pub folder: Option<String>,
    pub q: Option<String>,
    #[serde(default)]
    pub offset: i64,
    pub sort: Option<String>,
}
#[derive(Serialize)]
pub struct AssetLibrary {
    pub items: Vec<Asset>,
    pub total: i64,
}

impl Service {
    pub async fn asset_folders(&self, merchant: Uuid, actor: Uuid) -> Result<Vec<AssetFolder>> {
        self.authorize(merchant, actor, Access::Read).await?;
        Ok(sqlx::query_as("SELECT f.id,f.name,f.parent_id,count(a.id)::bigint AS asset_count FROM mobile.asset_folders f LEFT JOIN mobile.assets a ON a.merchant_id=f.merchant_id AND a.folder_id=f.id AND a.verified WHERE f.merchant_id=$1 GROUP BY f.id ORDER BY lower(f.name),f.id").bind(merchant).fetch_all(&self.pool).await?)
    }
    pub async fn save_asset_folder(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        id: Option<Uuid>,
        input: SaveFolder,
    ) -> Result<AssetFolder> {
        let name = input.name.trim();
        if name.is_empty()
            || name.chars().count() > 100
            || name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
        {
            return Err(invalid("/name", "INVALID_FOLDER_NAME"));
        }
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        for target in [id, input.parent_id].into_iter().flatten() {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM mobile.asset_folders WHERE merchant_id=$1 AND id=$2)",
            )
            .bind(merchant)
            .bind(target)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
        }
        let actual = id.unwrap_or_else(Uuid::new_v4);
        if let Some(parent) = input.parent_id {
            let cycle: bool = sqlx::query_scalar("WITH RECURSIVE tree AS (SELECT id FROM mobile.asset_folders WHERE merchant_id=$1 AND id=$2 UNION SELECT f.id FROM mobile.asset_folders f JOIN tree t ON f.parent_id=t.id WHERE f.merchant_id=$1) SELECT EXISTS(SELECT 1 FROM tree WHERE id=$3)").bind(merchant).bind(actual).bind(parent).fetch_one(&mut *tx).await?;
            if cycle {
                return Err(invalid("/parentId", "FOLDER_CYCLE"));
            }
        }
        let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mobile.asset_folders WHERE merchant_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(name)=lower($3) AND id<>$4)").bind(merchant).bind(input.parent_id).bind(name).bind(actual).fetch_one(&mut *tx).await?;
        if duplicate {
            return Err(invalid("/name", "DUPLICATE_FOLDER_NAME"));
        }
        sqlx::query("INSERT INTO mobile.asset_folders(id,merchant_id,name,parent_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$3,parent_id=$4").bind(actual).bind(merchant).bind(name).bind(input.parent_id).execute(&mut *tx).await?;
        let count = sqlx::query_scalar(
            "SELECT count(*) FROM mobile.assets WHERE merchant_id=$1 AND folder_id=$2 AND verified",
        )
        .bind(merchant)
        .bind(actual)
        .fetch_one(&mut *tx)
        .await?;
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "asset.folder_saved",
            serde_json::json!({"folderId":actual,"name":name,"parentId":input.parent_id}),
        )
        .await?;
        tx.commit().await?;
        Ok(AssetFolder {
            id: actual,
            name: name.into(),
            parent_id: input.parent_id,
            asset_count: count,
        })
    }
    pub async fn delete_asset_folder(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        id: Uuid,
    ) -> Result<()> {
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        if sqlx::query("DELETE FROM mobile.asset_folders WHERE merchant_id=$1 AND id=$2")
            .bind(merchant)
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "asset.folder_deleted",
            serde_json::json!({"folderId":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn move_assets(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        input: MoveAssets,
    ) -> Result<()> {
        let ids: std::collections::HashSet<_> = input.ids.iter().copied().collect();
        if ids.is_empty() || ids.len() > 100 || ids.len() != input.ids.len() {
            return Err(invalid("/ids", "INVALID_ASSET_SELECTION"));
        }
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        if let Some(folder) = input.folder_id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM mobile.asset_folders WHERE merchant_id=$1 AND id=$2)",
            )
            .bind(merchant)
            .bind(folder)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM mobile.assets WHERE merchant_id=$1 AND id=ANY($2) AND verified",
        )
        .bind(merchant)
        .bind(&input.ids)
        .fetch_one(&mut *tx)
        .await?;
        if count != input.ids.len() as i64 {
            return Err(Error::NotFound);
        }
        sqlx::query("UPDATE mobile.assets SET folder_id=$3 WHERE merchant_id=$1 AND id=ANY($2)")
            .bind(merchant)
            .bind(&input.ids)
            .bind(input.folder_id)
            .execute(&mut *tx)
            .await?;
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "asset.moved",
            serde_json::json!({"ids":input.ids,"folderId":input.folder_id}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn rename_asset(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        id: Uuid,
        input: RenameAsset,
    ) -> Result<()> {
        let name = input.name.trim();
        if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
            return Err(invalid("/name", "INVALID_ASSET_NAME"));
        }
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        if sqlx::query(
            "UPDATE mobile.assets SET name=$3 WHERE merchant_id=$1 AND id=$2 AND verified",
        )
        .bind(merchant)
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "asset.renamed",
            serde_json::json!({"assetId":id,"name":name}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn asset_library(
        &self,
        merchant: Uuid,
        actor: Uuid,
        query: LibraryQuery,
    ) -> Result<AssetLibrary> {
        self.authorize(merchant, actor, Access::Read).await?;
        let folder = query.folder.as_deref().unwrap_or("all");
        let folder_id = if folder == "all" || folder == "unfiled" {
            None
        } else {
            Some(Uuid::parse_str(folder).map_err(|_| invalid("/folder", "INVALID_FOLDER"))?)
        };
        let term = query.q.unwrap_or_default();
        if term.len() > 200
            || query.offset < 0
            || query.offset > 1_000_000
            || !matches!(query.sort.as_deref(), None | Some("recent" | "name"))
        {
            return Err(invalid("/query", "INVALID_LIBRARY_QUERY"));
        }
        // A single read snapshot keeps count and page consistent during moves.
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let total = sqlx::query_scalar("SELECT count(*) FROM mobile.assets WHERE merchant_id=$1 AND verified AND ($2='all' OR ($2='unfiled' AND folder_id IS NULL) OR folder_id=$3) AND strpos(lower(name),lower($4))>0").bind(merchant).bind(folder).bind(folder_id).bind(term.trim()).fetch_one(&mut *tx).await?;
        let items = sqlx::query_as("SELECT id,name,kind,verified,url,content_type,width,height,size_bytes,checksum,folder_id FROM mobile.assets WHERE merchant_id=$1 AND verified AND ($2='all' OR ($2='unfiled' AND folder_id IS NULL) OR folder_id=$3) AND strpos(lower(name),lower($4))>0 ORDER BY CASE WHEN $5='name' THEN lower(name) END ASC,created_at DESC,id DESC LIMIT 48 OFFSET $6").bind(merchant).bind(folder).bind(folder_id).bind(term.trim()).bind(query.sort.as_deref().unwrap_or("recent")).bind(query.offset).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(AssetLibrary { items, total })
    }
}
