//! Short-lived native draft sessions. No production enrollment credential grants draft access.
use crate::{
    service::{Access, Service},
    *,
};
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub id: Uuid,
    pub platform: String,
    pub implementation: String,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub applied_revision: Option<i64>,
    pub applied_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewAck {
    pub revision: i64,
    pub checksum: String,
}
#[derive(sqlx::FromRow)]
struct Grant {
    merchant_id: Uuid,
    environment: String,
}
impl Service {
    pub async fn start_preview(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
    ) -> Result<Value> {
        self.start_platform_preview(merchant, env, actor, Platform::Ios)
            .await
    }
    pub async fn start_platform_preview(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        platform: Platform,
    ) -> Result<Value> {
        self.start_implementation_preview(merchant, env, actor, platform, "native")
            .await
    }
    pub async fn start_implementation_preview(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        platform: Platform,
        implementation: &str,
    ) -> Result<Value> {
        self.create_implementation_preview(merchant, env, actor, platform, implementation, true)
            .await
    }
    /// Worker starts must never invalidate a live capability before capacity is accepted.
    pub async fn start_worker_preview(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        platform: Platform,
        implementation: &str,
    ) -> Result<Value> {
        self.create_implementation_preview(merchant, env, actor, platform, implementation, false)
            .await
    }
    async fn create_implementation_preview(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        platform: Platform,
        implementation: &str,
        replace: bool,
    ) -> Result<Value> {
        if !matches!(implementation, "native" | "react-native") {
            return Err(Error::Incompatible);
        }
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        let id = Uuid::new_v4();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        // write() holds the merchant row lock: concurrent starts cannot both pass.
        if !replace {
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mobile.preview_sessions WHERE merchant_id=$1 AND environment=$2 AND created_by=$3 AND revoked_at IS NULL AND expires_at>now())")
                .bind(merchant).bind(env.as_str()).bind(actor).fetch_one(&mut *tx).await?;
            if active {
                return Err(Error::Conflict);
            }
        } else {
            // Manual connection codes retain their explicit replacement behavior.
            sqlx::query("UPDATE mobile.preview_sessions SET revoked_at=now() WHERE merchant_id=$1 AND environment=$2 AND created_by=$3 AND revoked_at IS NULL")
                .bind(merchant).bind(env.as_str()).bind(actor).execute(&mut *tx).await?;
        }
        let expires: DateTime<Utc> = sqlx::query_scalar("INSERT INTO mobile.preview_sessions(id,merchant_id,environment,created_by,token_hash,platform,implementation) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expires_at")
            .bind(id).bind(merchant).bind(env.as_str()).bind(actor).bind(token_hash(&token)).bind(platform.as_str()).bind(implementation).fetch_one(&mut *tx).await?;
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "preview.started",
            serde_json::json!({"sessionId":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(serde_json::json!({"id":id,"code":format!("{id}.{token}"),"expiresAt":expires}))
    }
    pub async fn preview_status(
        &self,
        merchant: Uuid,
        actor: Uuid,
        id: Uuid,
    ) -> Result<PreviewStatus> {
        self.authorize(merchant, actor, Access::Edit).await?;
        sqlx::query_as("SELECT id,platform,implementation,expires_at,revoked_at,applied_revision,applied_at FROM mobile.preview_sessions WHERE id=$1 AND merchant_id=$2 AND created_by=$3")
            .bind(id).bind(merchant).bind(actor).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn stop_preview(&self, merchant: Uuid, actor: Uuid, id: Uuid) -> Result<()> {
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        let result = sqlx::query("UPDATE mobile.preview_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND merchant_id=$2 AND created_by=$3")
            .bind(id).bind(merchant).bind(actor).execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(Error::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }
    async fn preview_grant(
        &self,
        id: Uuid,
        token: &str,
        merchant: Uuid,
        env: Environment,
    ) -> Result<Transaction<'_, Postgres>> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Unauthorized);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        let grant: Grant = sqlx::query_as("SELECT p.merchant_id,p.environment FROM mobile.preview_sessions p JOIN mobile.memberships s ON s.merchant_id=p.merchant_id AND s.admin_id=p.created_by JOIN mobile.merchants m ON m.id=p.merchant_id JOIN admin_iam.admin_users u ON u.id=p.created_by WHERE p.id=$1 AND p.token_hash=$2 AND p.revoked_at IS NULL AND p.expires_at>now() AND m.active AND u.active AND s.role IN ('owner','designer') FOR UPDATE OF p")
            .bind(id).bind(token_hash(token)).fetch_optional(&mut *tx).await?.ok_or(Error::Unauthorized)?;
        if grant.merchant_id != merchant || grant.environment != env.as_str() {
            return Err(Error::Forbidden);
        }
        Ok(tx)
    }
    pub async fn preview_snapshot(
        &self,
        id: Uuid,
        token: &str,
        merchant: Uuid,
        env: Environment,
        runtime: &str,
    ) -> Result<Draft> {
        let mut tx = self.preview_grant(id, token, merchant, env).await?;
        let draft: Draft = sqlx::query_as("SELECT revision,config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2")
            .bind(merchant).bind(env.as_str()).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        Self::publishable(&mut tx, merchant, &draft.config).await?;
        let platform: String =
            sqlx::query_scalar("SELECT platform FROM mobile.preview_sessions WHERE id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let platform = if platform == "android" {
            Platform::Android
        } else {
            Platform::Ios
        };
        if !validation::compatible(&draft.config, platform, runtime) {
            return Err(Error::Incompatible);
        }
        sqlx::query("UPDATE mobile.preview_sessions SET delivered_revision=$2,delivered_checksum=$3 WHERE id=$1")
            .bind(id).bind(draft.revision).bind(checksum(&draft.config)).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(draft)
    }
    pub async fn acknowledge_preview(
        &self,
        id: Uuid,
        token: &str,
        merchant: Uuid,
        env: Environment,
        ack: PreviewAck,
    ) -> Result<()> {
        let mut tx = self.preview_grant(id, token, merchant, env).await?;
        let result = sqlx::query("UPDATE mobile.preview_sessions SET applied_revision=$2,applied_at=now() WHERE id=$1 AND delivered_revision=$2 AND delivered_checksum=$3 AND (applied_revision IS NULL OR applied_revision<=$2)")
            .bind(id).bind(ack.revision).bind(ack.checksum).execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(Error::Conflict);
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn preview_asset(
        &self,
        id: Uuid,
        token: &str,
        merchant: Uuid,
        env: Environment,
        asset: Uuid,
    ) -> Result<(String, String)> {
        let mut tx = self.preview_grant(id, token, merchant, env).await?;
        let config: Value = sqlx::query_scalar(
            "SELECT config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2",
        )
        .bind(merchant)
        .bind(env.as_str())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        if !validation::assets(&config).contains(&asset) {
            return Err(Error::NotFound);
        }
        let row: (String,String) = sqlx::query_as("SELECT object_key,checksum FROM mobile.assets WHERE id=$1 AND merchant_id=$2 AND verified AND object_key IS NOT NULL")
            .bind(asset).bind(merchant).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(row)
    }
}
