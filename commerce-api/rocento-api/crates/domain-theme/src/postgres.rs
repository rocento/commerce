use crate::{application::*, domain::*};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone)]
pub struct PostgresRepository {
    pool: PgPool,
    cache: Arc<RwLock<HashMap<Uuid, Version>>>,
}
fn storage(e: impl std::fmt::Display) -> Error {
    tracing::error!(error=%e, "theme storage failed");
    Error::Storage
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(storage)
}
impl PostgresRepository {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            cache: Default::default(),
        }
    }
    async fn lock(&self) -> Result<Transaction<'_, Postgres>> {
        let mut tx = self.pool.begin().await.map_err(storage)?;
        // Theme mutations are rare; one transaction lock also orders cross-theme assignments.
        sqlx::query("SELECT pg_advisory_xact_lock(7011)")
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
        Ok(tx)
    }
    async fn check(tx: &mut Transaction<'_, Postgres>, id: Uuid, revision: i32) -> Result<()> {
        let current: Option<i32> =
            sqlx::query_scalar("SELECT revision FROM theme.themes WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(storage)?;
        match current {
            None => Err(Error::NotFound),
            Some(v) if v != revision => Err(Error::Conflict),
            _ => Ok(()),
        }
    }
    async fn assets(tx: &mut Transaction<'_, Postgres>, config: &Configuration) -> Result<()> {
        let ids = config.assets();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog.media WHERE id=ANY($1) AND content_type IN ('image/jpeg','image/png','image/webp','image/avif') AND size_bytes BETWEEN 1 AND 10485760").bind(&ids).fetch_one(&mut **tx).await.map_err(storage)?;
        if count != ids.len() as i64 {
            return Err(Error::Invalid(
                "assets must reference existing raster images up to 10 MiB".into(),
            ));
        }
        Ok(())
    }
    async fn audit_tx(
        tx: &mut Transaction<'_, Postgres>,
        actor: Uuid,
        action: &str,
        id: Uuid,
        details: Value,
    ) -> Result<()> {
        domain_admin_iam::Service::audit(tx, Some(actor), action, id, details)
            .await
            .map_err(storage)
    }
    async fn draft_assets(
        tx: &mut Transaction<'_, Postgres>,
        id: Uuid,
        config: &Configuration,
    ) -> Result<()> {
        sqlx::query("DELETE FROM theme.draft_assets WHERE theme_id=$1")
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(storage)?;
        sqlx::query(
            "INSERT INTO theme.draft_assets(theme_id,media_id) SELECT $1,unnest($2::uuid[])",
        )
        .bind(id)
        .bind(config.assets())
        .execute(&mut **tx)
        .await
        .map_err(storage)?;
        Ok(())
    }
}
impl Repository for PostgresRepository {
    async fn list(&self) -> Result<Vec<Theme>> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(t) FROM theme.themes t ORDER BY updated_at DESC LIMIT 500",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        rows.into_iter().map(decode).collect()
    }
    async fn get(&self, id: Uuid) -> Result<Theme> {
        decode(
            sqlx::query_scalar("SELECT to_jsonb(t) FROM theme.themes t WHERE id=$1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?,
        )
    }
    async fn assignments(&self) -> Result<Vec<Assignment>> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('channel',c.channel_id,'theme_id',a.theme_id,'revision',coalesce(a.revision,0),'rules',coalesce(a.rules,'[]'::jsonb)) FROM inventory.sales_channel_stock_links c LEFT JOIN theme.assignments a ON a.channel=c.channel_id ORDER BY c.channel_id").fetch_all(&self.pool).await.map_err(storage)?;
        rows.into_iter().map(decode).collect()
    }
    async fn versions(&self, id: Uuid) -> Result<Vec<Version>> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(v) FROM theme.versions v WHERE theme_id=$1 ORDER BY number DESC LIMIT 100").bind(id).fetch_all(&self.pool).await.map_err(storage)?;
        rows.into_iter().map(decode).collect()
    }
    async fn version(&self, theme: Uuid, id: Uuid) -> Result<Version> {
        decode(
            sqlx::query_scalar(
                "SELECT to_jsonb(v) FROM theme.versions v WHERE theme_id=$1 AND id=$2",
            )
            .bind(theme)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?,
        )
    }
    async fn create(&self, i: &Create, config: &Configuration, actor: Uuid) -> Result<Theme> {
        let mut tx = self.lock().await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM inventory.sales_channel_stock_links WHERE channel_id=$1)",
        )
        .bind(&i.owner_channel)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage)?;
        if !exists {
            return Err(Error::NotFound);
        }
        Self::assets(&mut tx, config).await?;
        let id = Uuid::new_v4();
        let v = sqlx::query_scalar("INSERT INTO theme.themes AS t(id,name,owner_channel,configuration,created_by) VALUES($1,$2,$3,$4,$5) RETURNING to_jsonb(t)").bind(id).bind(i.name.trim()).bind(&i.owner_channel).bind(json!(config)).bind(actor).fetch_one(&mut *tx).await.map_err(storage)?;
        Self::draft_assets(&mut tx, id, config).await?;
        Self::audit_tx(
            &mut tx,
            actor,
            if i.source.is_some() {
                "THEME_DUPLICATED"
            } else {
                "THEME_CREATED"
            },
            id,
            json!({"channel":i.owner_channel,"source":i.source}),
        )
        .await?;
        tx.commit().await.map_err(storage)?;
        decode(v)
    }
    async fn save(
        &self,
        id: Uuid,
        revision: i32,
        config: &Configuration,
        actor: Uuid,
    ) -> Result<Theme> {
        let mut tx = self.lock().await?;
        Self::check(&mut tx, id, revision).await?;
        Self::assets(&mut tx, config).await?;
        let value = sqlx::query_scalar("UPDATE theme.themes t SET configuration=$2, revision=revision+1,updated_at=now() WHERE id=$1 RETURNING to_jsonb(t)").bind(id).bind(json!(config)).fetch_one(&mut *tx).await.map_err(storage)?;
        Self::draft_assets(&mut tx, id, config).await?;
        Self::audit_tx(
            &mut tx,
            actor,
            "THEME_UPDATED",
            id,
            json!({"revision":revision+1}),
        )
        .await?;
        tx.commit().await.map_err(storage)?;
        decode(value)
    }
    async fn publish(
        &self,
        id: Uuid,
        revision: i32,
        config: &Configuration,
        source: Option<Uuid>,
        actor: Uuid,
    ) -> Result<Version> {
        let mut tx = self.lock().await?;
        Self::check(&mut tx, id, revision).await?;
        Self::assets(&mut tx, config).await?;
        let version = Uuid::new_v4();
        let value = sqlx::query_scalar("INSERT INTO theme.versions AS v(id,theme_id,number,configuration,created_by,source_version) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM theme.versions WHERE theme_id=$2),$3,$4,$5) RETURNING to_jsonb(v)").bind(version).bind(id).bind(json!(config)).bind(actor).bind(source).fetch_one(&mut *tx).await.map_err(storage)?;
        sqlx::query(
            "INSERT INTO theme.version_assets(version_id,media_id) SELECT $1,unnest($2::uuid[])",
        )
        .bind(version)
        .bind(config.assets())
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
        sqlx::query("UPDATE theme.themes SET published_version=$2,revision=revision+1,updated_at=now() WHERE id=$1").bind(id).bind(version).execute(&mut *tx).await.map_err(storage)?;
        Self::audit_tx(
            &mut tx,
            actor,
            if source.is_some() {
                "THEME_ROLLED_BACK"
            } else {
                "THEME_PUBLISHED"
            },
            id,
            json!({"version":version,"source_version":source}),
        )
        .await?;
        tx.commit().await.map_err(storage)?;
        tracing::info!(
            operation = "theme_publish_success",
            "theme publication committed"
        );
        decode(value)
    }
    async fn assign(&self, channel: &str, i: &Assign, actor: Uuid) -> Result<Assignment> {
        let mut tx = self.lock().await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM inventory.sales_channel_stock_links WHERE channel_id=$1)",
        )
        .bind(channel)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage)?;
        if !exists {
            return Err(Error::NotFound);
        }
        sqlx::query("INSERT INTO theme.assignments(channel) VALUES($1) ON CONFLICT DO NOTHING")
            .bind(channel)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
        let (previous, revision): (Option<Uuid>, i32) = sqlx::query_as(
            "SELECT theme_id,revision FROM theme.assignments WHERE channel=$1 FOR UPDATE",
        )
        .bind(channel)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage)?;
        if revision != i.expected_revision {
            return Err(Error::Conflict);
        }
        let old_rules: Value =
            sqlx::query_scalar("SELECT rules FROM theme.assignments WHERE channel=$1")
                .bind(channel)
                .fetch_one(&mut *tx)
                .await
                .map_err(storage)?;
        for rule in &i.rules {
            for (table, id) in [
                ("customers.segments", rule.segment_id),
                ("inventory.delivery_areas", rule.area_id),
                ("inventory.stocks", rule.stock_id),
            ] {
                if let Some(id) = id {
                    let exists: bool = sqlx::query_scalar(&format!(
                        "SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1)"
                    ))
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(storage)?;
                    if !exists {
                        return Err(Error::Invalid(
                            "Target segment, zone or stock no longer exists".into(),
                        ));
                    }
                }
            }
            if let (Some(area), Some(stock)) = (rule.area_id, rule.stock_id) {
                let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.area_stock_links WHERE area_id=$1 AND stock_id=$2)").bind(area).bind(stock).fetch_one(&mut *tx).await.map_err(storage)?;
                if !linked {
                    return Err(Error::Invalid(
                        "Stock is not assigned to the selected geofence zone".into(),
                    ));
                }
            }
        }
        for id in i
            .theme_id
            .into_iter()
            .chain(i.rules.iter().map(|r| r.theme_id))
        {
            let ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM theme.themes WHERE id=$1 AND published_version IS NOT NULL)").bind(id).fetch_one(&mut *tx).await.map_err(storage)?;
            if !ready {
                return Err(Error::Invalid(
                    "ThemeNotPublishable: publish before assignment".into(),
                ));
            }
        }
        let value = sqlx::query_scalar("UPDATE theme.assignments a SET theme_id=$2, rules=$3, revision=revision+1,updated_at=now() WHERE channel=$1 RETURNING to_jsonb(a)").bind(channel).bind(i.theme_id).bind(json!(i.rules)).fetch_one(&mut *tx).await.map_err(storage)?;
        // Assignment changes invalidate in-flight publication authorization via its revision guard.
        sqlx::query(
            "UPDATE theme.themes SET revision=revision+1,updated_at=now() WHERE id=$1 OR id=$2 OR id=ANY($3)",
        )
        .bind(previous)
        .bind(i.theme_id)
        .bind(decode::<Vec<TargetRule>>(old_rules)?.iter().map(|r| r.theme_id).chain(i.rules.iter().map(|r| r.theme_id)).collect::<Vec<_>>())
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
        Self::audit_tx(
            &mut tx,
            actor,
            "THEME_ASSIGNED",
            i.theme_id.or(previous).unwrap_or(Uuid::nil()),
            json!({"channel":channel,"theme_id":i.theme_id,"rules":i.rules,"revision":revision+1}),
        )
        .await?;
        tx.commit().await.map_err(storage)?;
        decode(value)
    }
    async fn validate_assets(&self, config: &Configuration) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(storage)?;
        Self::assets(&mut tx, config).await
    }
    async fn audit(&self, actor: Uuid, action: &str, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(storage)?;
        Self::audit_tx(&mut tx, actor, action, id, json!({})).await?;
        tx.commit().await.map_err(storage)
    }
    async fn resolve_targeted(
        &self,
        channel: &str,
        context: &TargetContext,
    ) -> Result<Option<Version>> {
        let rules: Option<Value> =
            sqlx::query_scalar("SELECT rules FROM theme.assignments WHERE channel=$1")
                .bind(channel)
                .fetch_optional(&self.pool)
                .await
                .map_err(storage)?;
        for rule in decode::<Vec<TargetRule>>(rules.unwrap_or(json!([])))? {
            if rule.matches(context) {
                let id: Option<Uuid> =
                    sqlx::query_scalar("SELECT published_version FROM theme.themes WHERE id=$1")
                        .bind(rule.theme_id)
                        .fetch_optional(&self.pool)
                        .await
                        .map_err(storage)?
                        .flatten();
                if let Some(id) = id {
                    return self.version(rule.theme_id, id).await.map(Some);
                }
            }
        }
        self.resolve(channel).await
    }
    async fn resolve(&self, channel: &str) -> Result<Option<Version>> {
        let started = std::time::Instant::now();
        // The small indexed pointer read is authoritative across all gateway replicas.
        let pointer: Option<(Uuid, Uuid)> = sqlx::query_as("SELECT t.id,t.published_version FROM theme.assignments a JOIN theme.themes t ON t.id=a.theme_id WHERE a.channel=$1 AND t.published_version IS NOT NULL").bind(channel).fetch_optional(&self.pool).await.map_err(storage)?;
        let Some((theme, id)) = pointer else {
            return Ok(None);
        };
        if let Some(v) = self.cache.read().await.get(&id) {
            tracing::debug!(operation = "theme_cache_hit", "theme cache hit");
            return Ok(Some(v.clone()));
        }
        let v = self.version(theme, id).await?;
        let mut cache = self.cache.write().await;
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(id, v.clone());
        tracing::debug!(
            operation = "theme_cache_miss",
            duration_seconds = started.elapsed().as_secs_f64(),
            "theme resolved"
        );
        Ok(Some(v))
    }
}
