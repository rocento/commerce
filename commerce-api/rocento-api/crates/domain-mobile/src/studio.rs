use crate::{
    service::{Access, Service},
    *,
};

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Merchant {
    pub id: Uuid,
    pub name: String,
    pub role: String,
    pub entitlements: Value,
}
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub verified: bool,
    pub url: Option<String>,
    pub content_type: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub size_bytes: Option<i64>,
    pub checksum: String,
    pub folder_id: Option<Uuid>,
}
pub struct Upload {
    pub id: Uuid,
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub size_bytes: i64,
    pub checksum: String,
    pub folder_id: Option<Uuid>,
}
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: Uuid,
    pub actor_id: Uuid,
    pub action: String,
    pub details: Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
impl Service {
    pub async fn merchants(&self, actor: Uuid) -> Result<Vec<Merchant>> {
        Ok(sqlx::query_as("SELECT m.id,m.name,s.role,m.entitlements FROM mobile.merchants m JOIN mobile.memberships s ON s.merchant_id=m.id JOIN admin_iam.admin_users u ON u.id=s.admin_id WHERE s.admin_id=$1 AND m.active AND u.active ORDER BY m.name,m.id")
            .bind(actor).fetch_all(&self.pool).await?)
    }
    pub async fn assets(
        &self,
        merchant: Uuid,
        actor: Uuid,
        before: Option<Uuid>,
    ) -> Result<Vec<Asset>> {
        self.authorize(merchant, actor, Access::Read).await?;
        Ok(sqlx::query_as("SELECT id,name,kind,verified,url,content_type,width,height,size_bytes,checksum,folder_id FROM mobile.assets WHERE merchant_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 100")
            .bind(merchant).bind(before).fetch_all(&self.pool).await?)
    }
    pub async fn upload(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        input: Upload,
    ) -> Result<Asset> {
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        if input.name.trim().is_empty()
            || input.name.len() > 200
            || input.name.chars().any(char::is_control)
        {
            return Err(invalid("/name", "INVALID_ASSET_NAME"));
        }
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
        let row: Asset = sqlx::query_as("INSERT INTO mobile.assets(id,merchant_id,kind,verified,checksum,object_key,name,content_type,width,height,size_bytes,folder_id) VALUES($1,$2,'image',true,$3,$4,$5,'image/png',$6,$7,$8,$9) RETURNING id,name,kind,verified,url,content_type,width,height,size_bytes,checksum,folder_id")
            .bind(input.id).bind(merchant).bind(&input.checksum).bind(format!("mobile/{merchant}/{}",input.id)).bind(input.name.trim()).bind(input.width).bind(input.height).bind(input.size_bytes).bind(input.folder_id).fetch_one(&mut *tx).await?;
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "asset.uploaded",
            serde_json::json!({"assetId":row.id,"name":row.name,"checksum":row.checksum}),
        )
        .await?;
        tx.commit().await?;
        Ok(row)
    }
    pub async fn asset_object(&self, merchant: Uuid, actor: Uuid, asset: Uuid) -> Result<String> {
        self.authorize(merchant, actor, Access::Read).await?;
        sqlx::query_scalar("SELECT object_key FROM mobile.assets WHERE merchant_id=$1 AND id=$2 AND verified AND object_key IS NOT NULL")
            .bind(merchant).bind(asset).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn audits(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        before: Option<Uuid>,
    ) -> Result<Vec<AuditEvent>> {
        self.authorize(merchant, actor, Access::Read).await?;
        Ok(sqlx::query_as("SELECT id,actor_id,action,details,created_at FROM mobile.audit_events WHERE merchant_id=$1 AND environment=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mobile.audit_events WHERE id=$3 AND merchant_id=$1 AND environment=$2)) ORDER BY created_at DESC,id DESC LIMIT 50")
            .bind(merchant).bind(env.as_str()).bind(before).fetch_all(&self.pool).await?)
    }
}
