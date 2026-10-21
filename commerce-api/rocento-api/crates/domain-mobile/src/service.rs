use crate::*;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};

#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Clone, Copy)]
pub enum Access {
    Read,
    Edit,
    Publish,
    Build,
}
impl Service {
    pub async fn authorize(&self, merchant: Uuid, actor: Uuid, access: Access) -> Result<()> {
        let role: Option<String>=sqlx::query_scalar("SELECT s.role FROM mobile.memberships s JOIN mobile.merchants m ON m.id=s.merchant_id JOIN admin_iam.admin_users u ON u.id=s.admin_id WHERE s.merchant_id=$1 AND s.admin_id=$2 AND m.active AND u.active")
            .bind(merchant).bind(actor).fetch_optional(&self.pool).await?;
        let allowed = matches!(
            (role.as_deref(), access),
            (Some("owner"), _)
                | (Some("designer"), Access::Read | Access::Edit)
                | (Some("operator"), Access::Read)
                | (Some("release_admin"), Access::Read | Access::Build)
        );
        if allowed {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
    // Recheck membership inside the write transaction; lock it and the merchant
    // so revocation, entitlement changes and competing writes serialize.
    pub(crate) async fn write(
        &self,
        merchant: Uuid,
        actor: Uuid,
        access: Access,
    ) -> Result<Transaction<'_, Postgres>> {
        self.authorize(merchant, actor, access).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT id FROM mobile.merchants WHERE id=$1 FOR UPDATE")
            .bind(merchant)
            .execute(&mut *tx)
            .await?;
        let role:Option<String>=sqlx::query_scalar("SELECT s.role FROM mobile.memberships s JOIN admin_iam.admin_users u ON u.id=s.admin_id JOIN mobile.merchants m ON m.id=s.merchant_id WHERE s.merchant_id=$1 AND s.admin_id=$2 AND u.active AND m.active FOR SHARE OF s,u")
            .bind(merchant).bind(actor).fetch_optional(&mut *tx).await?;
        if !matches!(
            (role.as_deref(), access),
            (Some("owner"), _)
                | (Some("designer"), Access::Edit)
                | (Some("release_admin"), Access::Build)
        ) {
            return Err(Error::Forbidden);
        }
        Ok(tx)
    }
    pub(crate) async fn audit(
        tx: &mut Transaction<'_, Postgres>,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        action: &str,
        details: Value,
    ) -> Result<()> {
        sqlx::query("INSERT INTO mobile.audit_events(id,merchant_id,environment,actor_id,action,details) VALUES($1,$2,$3,$4,$5,$6)").bind(Uuid::new_v4()).bind(merchant).bind(env.as_str()).bind(actor).bind(action).bind(details).execute(&mut **tx).await?;
        Ok(())
    }
    pub async fn draft(&self, merchant: Uuid, env: Environment, actor: Uuid) -> Result<Draft> {
        self.authorize(merchant, actor, Access::Read).await?;
        sqlx::query_as("SELECT revision,config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2").bind(merchant).bind(env.as_str()).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn save(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        input: SaveDraft,
    ) -> Result<Draft> {
        let mut tx = self.write(merchant, actor, Access::Edit).await?;
        validation::config(&input.config, merchant)?;
        if input.config["configVersion"] != 0 {
            return Err(invalid("/configVersion", "DRAFT_VERSION_MUST_BE_ZERO"));
        }
        if input.expected_revision < 0 || input.expected_revision == i64::MAX {
            return Err(invalid("/expectedRevision", "INVALID_REVISION"));
        }
        let previous: Option<Value> = sqlx::query_scalar(
            "SELECT config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2",
        )
        .bind(merchant)
        .bind(env.as_str())
        .fetch_optional(&mut *tx)
        .await?;
        let row:Option<Draft>=sqlx::query_as("INSERT INTO mobile.config_drafts(merchant_id,environment,revision,config,updated_by) SELECT $1,$2,1,$3,$4 WHERE $5=0 ON CONFLICT(merchant_id,environment) DO NOTHING RETURNING revision,config")
            .bind(merchant).bind(env.as_str()).bind(&input.config).bind(actor).bind(input.expected_revision).fetch_optional(&mut *tx).await?;
        let row = if let Some(row) = row {
            row
        } else {
            sqlx::query_as("UPDATE mobile.config_drafts SET config=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE merchant_id=$1 AND environment=$2 AND revision=$5 RETURNING revision,config")
                .bind(merchant).bind(env.as_str()).bind(&input.config).bind(actor).bind(input.expected_revision).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?
        };
        Self::audit(
            &mut tx,
            merchant,
            env,
            actor,
            "config.draft_saved",
            json!({"revision":row.revision,"before":previous,"after":row.config}),
        )
        .await?;
        tx.commit().await?;
        Ok(row)
    }
    pub(crate) async fn publishable(
        tx: &mut Transaction<'_, Postgres>,
        merchant: Uuid,
        config: &Value,
    ) -> Result<()> {
        validation::config(config, merchant)?;
        let entitlements: Value =
            sqlx::query_scalar("SELECT entitlements FROM mobile.merchants WHERE id=$1 AND active")
                .bind(merchant)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or(Error::Forbidden)?;
        for (feature, enabled) in config["features"].as_object().unwrap() {
            if enabled == true && entitlements[feature] != true {
                return Err(invalid(
                    &format!("/features/{feature}"),
                    "ENTITLEMENT_REQUIRED",
                ));
            }
        }
        for id in validation::assets(config) {
            Self::asset(tx, merchant, id, "image").await?;
        }
        Ok(())
    }
    async fn asset(
        tx: &mut Transaction<'_, Postgres>,
        merchant: Uuid,
        id: Uuid,
        kind: &str,
    ) -> Result<()> {
        let exists:Option<Uuid>=sqlx::query_scalar("SELECT id FROM mobile.assets WHERE merchant_id=$1 AND id=$2 AND kind=$3 AND verified FOR SHARE")
            .bind(merchant).bind(id).bind(kind).fetch_optional(&mut **tx).await?;
        if exists.is_none() {
            return Err(invalid("/assets", "ASSET_NOT_OWNED_OR_VERIFIED"));
        }
        Ok(())
    }
    pub async fn validate(&self, merchant: Uuid, env: Environment, actor: Uuid) -> Result<()> {
        self.authorize(merchant, actor, Access::Read).await?;
        let mut tx = self.pool.begin().await?;
        let config: Value = sqlx::query_scalar(
            "SELECT config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2",
        )
        .bind(merchant)
        .bind(env.as_str())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        Self::publishable(&mut tx, merchant, &config).await
    }
    fn key(key: &str) -> Result<()> {
        if key.len() < 8
            || key.len() > 128
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
        {
            Err(invalid("/Idempotency-Key", "INVALID_IDEMPOTENCY_KEY"))
        } else {
            Ok(())
        }
    }
    async fn replay(
        tx: &mut Transaction<'_, Postgres>,
        merchant: Uuid,
        env: Environment,
        key: &str,
        hash: &str,
    ) -> Result<Option<Value>> {
        let previous:Option<(String,Value)>=sqlx::query_as("SELECT request_checksum,response FROM mobile.idempotency WHERE merchant_id=$1 AND environment=$2 AND key=$3").bind(merchant).bind(env.as_str()).bind(key).fetch_optional(&mut **tx).await?;
        match previous {
            Some((old, _)) if old != hash => Err(Error::Conflict),
            Some((_, body)) => Ok(Some(body)),
            None => Ok(None),
        }
    }
    async fn receipt(
        tx: &mut Transaction<'_, Postgres>,
        merchant: Uuid,
        env: Environment,
        key: &str,
        hash: &str,
        body: &Value,
    ) -> Result<()> {
        sqlx::query("INSERT INTO mobile.idempotency(merchant_id,environment,key,request_checksum,response) VALUES($1,$2,$3,$4,$5)").bind(merchant).bind(env.as_str()).bind(key).bind(hash).bind(body).execute(&mut **tx).await?;
        Ok(())
    }
    pub async fn publish(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        revision: i64,
        target: Option<i64>,
        key: &str,
    ) -> Result<Value> {
        Self::key(key)?;
        let mut tx = self.write(merchant, actor, Access::Publish).await?;
        let request_hash = checksum(
            &json!({"action":if target.is_some(){"rollback"}else{"publish"},"revision":revision,"target":target,"actor":actor}),
        );
        if let Some(body) = Self::replay(&mut tx, merchant, env, key, &request_hash).await? {
            return Ok(body);
        }
        let draft:Draft=sqlx::query_as("SELECT revision,config FROM mobile.config_drafts WHERE merchant_id=$1 AND environment=$2").bind(merchant).bind(env.as_str()).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        if draft.revision != revision {
            return Err(Error::Conflict);
        }
        let mut config = if let Some(target) = target {
            sqlx::query_scalar("SELECT config FROM mobile.config_versions WHERE merchant_id=$1 AND environment=$2 AND version=$3").bind(merchant).bind(env.as_str()).bind(target).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?
        } else {
            draft.config
        };
        Self::publishable(&mut tx, merchant, &config).await?;
        // Production drafts publish directly after the same owner, revision,
        // schema, asset and entitlement checks. App Studio is production-only.
        let latest:i64=sqlx::query_scalar("SELECT COALESCE(MAX(version),0) FROM mobile.config_versions WHERE merchant_id=$1 AND environment=$2").bind(merchant).bind(env.as_str()).fetch_one(&mut *tx).await?;
        let version = latest
            .checked_add(1)
            .filter(|v| *v <= i32::MAX as i64)
            .ok_or(Error::Conflict)?;
        config["configVersion"] = json!(version);
        let hash = checksum(&config);
        let row:Version=sqlx::query_as("INSERT INTO mobile.config_versions(merchant_id,environment,version,config,checksum,schema_version,published_by,rollback_target) VALUES($1,$2,$3,$4,$5,'1.0.0',$6,$7) RETURNING version,config,checksum,published_by,published_at,rollback_target")
            .bind(merchant).bind(env.as_str()).bind(version).bind(&config).bind(hash).bind(actor).bind(if latest==0 {None}else{Some(latest)}).fetch_one(&mut *tx).await?;
        let body = serde_json::to_value(row).map_err(|_| Error::Storage)?;
        config["configVersion"] = json!(0);
        // Advancing the revision makes concurrent publishes with different keys conflict.
        sqlx::query("UPDATE mobile.config_drafts SET revision=revision+1,config=$3,updated_by=$4,updated_at=now() WHERE merchant_id=$1 AND environment=$2").bind(merchant).bind(env.as_str()).bind(config).bind(actor).execute(&mut *tx).await?;
        Self::audit(&mut tx,merchant,env,actor,if target.is_some(){"config.rolled_back"}else{"config.published"},json!({"version":version,"previousVersion":latest,"sourceVersion":target,"checksum":body["checksum"]})).await?;
        Self::receipt(&mut tx, merchant, env, key, &request_hash, &body).await?;
        tx.commit().await?;
        tracing::info!(merchant=%merchant,environment=env.as_str(),version,"mobile configuration published");
        Ok(body)
    }
    pub async fn versions(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        before: i64,
    ) -> Result<Vec<Version>> {
        self.authorize(merchant, actor, Access::Read).await?;
        Ok(sqlx::query_as("SELECT version,config,checksum,published_by,published_at,rollback_target FROM mobile.config_versions WHERE merchant_id=$1 AND environment=$2 AND version<$3 ORDER BY version DESC LIMIT 50").bind(merchant).bind(env.as_str()).bind(before).fetch_all(&self.pool).await?)
    }
    pub async fn resolve(
        &self,
        token: &str,
        platform: Platform,
        runtime: &str,
        locale: &str,
    ) -> Result<Version> {
        if token.len() < 32 || token.len() > 256 {
            return Err(Error::Unauthorized);
        }
        let context:Option<(Uuid,String)>=sqlx::query_as("SELECT i.merchant_id,i.environment FROM mobile.app_sessions s JOIN mobile.app_identities i ON i.id=s.identity_id JOIN mobile.merchants m ON m.id=i.merchant_id LEFT JOIN mobile.devices d ON d.id=s.device_id WHERE (s.device_id IS NULL OR (d.revoked_at IS NULL AND d.expires_at>now() AND d.identity_id=i.id)) AND s.token_hash=$1 AND s.expires_at>now() AND i.active AND m.active AND i.platform=$2")
            .bind(token_hash(token)).bind(platform.as_str()).fetch_optional(&self.pool).await?;
        let (merchant, env) = context.ok_or(Error::Unauthorized)?;
        if validation::runtime(runtime).is_none() {
            return Err(invalid("/runtimeVersion", "INVALID_RUNTIME"));
        }
        if !["en", "ar"].contains(&locale) {
            return Err(invalid("/locale", "UNSUPPORTED_LOCALE"));
        }
        // The latest publication is authoritative, including rollback. Never walk
        // backward into superseded history when the latest is incompatible.
        let row:Version=sqlx::query_as("SELECT version,config,checksum,published_by,published_at,rollback_target FROM mobile.config_versions WHERE merchant_id=$1 AND environment=$2 ORDER BY version DESC LIMIT 1").bind(merchant).bind(env).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        if !validation::compatible(&row.config, platform, runtime) {
            return Err(Error::Incompatible);
        }
        Ok(row)
    }
    pub async fn builds(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
    ) -> Result<Vec<Build>> {
        self.authorize(merchant, actor, Access::Read).await?;
        Ok(sqlx::query_as("SELECT id,platform,build_number,source_commit,manifest_checksum,status,created_at FROM mobile.app_builds WHERE merchant_id=$1 AND environment=$2 ORDER BY created_at DESC,id LIMIT 50").bind(merchant).bind(env.as_str()).fetch_all(&self.pool).await?)
    }
    pub async fn build(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        id: Uuid,
    ) -> Result<Build> {
        self.authorize(merchant, actor, Access::Read).await?;
        sqlx::query_as("SELECT id,platform,build_number,source_commit,manifest_checksum,status,created_at FROM mobile.app_builds WHERE merchant_id=$1 AND environment=$2 AND id=$3").bind(merchant).bind(env.as_str()).bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn queue_build(
        &self,
        merchant: Uuid,
        env: Environment,
        actor: Uuid,
        input: QueueBuild,
        key: &str,
    ) -> Result<Value> {
        Self::key(key)?;
        let mut tx = self.write(merchant, actor, Access::Build).await?;
        validation::manifest(&input.manifest, merchant)?;
        let m = &input.manifest;
        if m["environment"] != env.as_str() {
            return Err(invalid("/manifest/environment", "ENVIRONMENT_MISMATCH"));
        }
        let request_hash = checksum(&json!({"action":"build","input":input,"actor":actor}));
        if let Some(body) = Self::replay(&mut tx, merchant, env, key, &request_hash).await? {
            return Ok(body);
        }
        for (field, kind) in [("iconAssetId", "icon"), ("splashAssetId", "splash")] {
            Self::asset(
                &mut tx,
                merchant,
                Uuid::parse_str(m[field].as_str().unwrap())
                    .map_err(|_| invalid(field, "INVALID_ASSET"))?,
                kind,
            )
            .await?;
        }
        let identifier = match input.platform {
            Platform::Ios => "iosBundleId",
            Platform::Android => "androidApplicationId",
        };
        let identity:Option<Uuid>=sqlx::query_scalar("SELECT id FROM mobile.app_identities WHERE merchant_id=$1 AND environment=$2 AND platform=$3 AND identifier=$4 AND store_account_ref=$5 AND active FOR SHARE")
            .bind(merchant).bind(env.as_str()).bind(input.platform.as_str()).bind(m[identifier].as_str().unwrap()).bind(m["storeAccountRef"].as_str().unwrap()).fetch_optional(&mut *tx).await?;
        if identity.is_none() {
            return Err(invalid("/manifest", "APP_IDENTITY_NOT_PROVISIONED"));
        }
        let number:i64=sqlx::query_scalar("SELECT COALESCE(MAX(build_number),0)+1 FROM mobile.app_builds WHERE merchant_id=$1 AND environment=$2 AND platform=$3").bind(merchant).bind(env.as_str()).bind(input.platform.as_str()).fetch_one(&mut *tx).await?;
        let row:Build=sqlx::query_as("INSERT INTO mobile.app_builds(id,merchant_id,environment,platform,build_number,source_commit,manifest,manifest_checksum,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,platform,build_number,source_commit,manifest_checksum,status,created_at")
            .bind(Uuid::new_v4()).bind(merchant).bind(env.as_str()).bind(input.platform.as_str()).bind(number).bind(m["sourceCommit"].as_str().unwrap()).bind(m).bind(checksum(m)).bind(actor).fetch_one(&mut *tx).await?;
        let body = serde_json::to_value(row).map_err(|_| Error::Storage)?;
        Self::audit(&mut tx, merchant, env, actor, "build.queued", body.clone()).await?;
        Self::receipt(&mut tx, merchant, env, key, &request_hash, &body).await?;
        tx.commit().await?;
        Ok(body)
    }
}
