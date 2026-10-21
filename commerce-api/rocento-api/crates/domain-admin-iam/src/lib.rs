use chrono::{DateTime, Utc};
use infra_auth::{Error, Result, Security};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
pub const PERMISSIONS: &[&str] = &[
    "api.docs.read",
    "fulfillment.settings.view",
    "fulfillment.settings.manage",
    "fulfillment.pickup.manage",
    "fulfillment.capacity.view",
    "fulfillment.capacity.manage",
    "fulfillment.schedule.view",
    "fulfillment.schedule.manage",
    "fulfillment.override.manage",
    "assistant.settings.read",
    "assistant.settings.write",
    "email_templates.read",
    "email_templates.write",
    "email_templates.publish",
    "notifications.read",
    "notifications.write",
    "notifications.generate",
    "notifications.publish",
    "assistant.tracking.read",
    "assistant.tracking.export",
    "markets.read",
    "markets.write",
    "markets.publish",
    "languages.read",
    "languages.write",
    "discovery.read",
    "discovery.write",
    "theme.read",
    "theme.create",
    "theme.edit",
    "theme.preview",
    "theme.publish",
    "theme.rollback",
    "theme.assign",
    "attributes.read",
    "attributes.write",
    "customers.read",
    "customers.retention",
    "customers.segments.write",
    "support.read",
    "support.write",
    "reports.read",
    "cms.read",
    "cms.write",
    "cms.publish",
    "reviews.read",
    "reviews.moderate",
    "catalog.bulk",
    "catalog.import",
    "catalog.export",
    "inventory.import",
    "inventory.export",
    "promotions.read",
    "promotions.write",
    "tax.read",
    "tax.write",
    "fulfillment.settings.read",
    "fulfillment.settings.write",
    "fulfillment.dispatch",
    "orders.read",
    "orders.write",
    "orders.statuses.read",
    "orders.statuses.manage",
    "payments.collect",
    "payments.refund",
    "inventory.read",
    "inventory.write",
    "catalog.read",
    "catalog.write",
    "iam.users.read",
    "iam.users.write",
    "iam.roles.read",
    "iam.roles.write",
    "iam.audit.read",
];
pub const SUPER: Uuid = Uuid::from_u128(1);
fn valid_permission(p: &str) -> bool {
    PERMISSIONS.contains(&p)
        || p.split_once('@').is_some_and(|(operation, channel)| {
            operation.starts_with("theme.")
                && PERMISSIONS.contains(&operation)
                && !channel.is_empty()
                && channel.len() <= 100
                && channel
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub security: Security,
}
#[derive(Serialize, FromRow)]
pub struct Admin {
    pub entity_id: i64,
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub role_id: Uuid,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct Identity {
    pub user: Admin,
    pub permissions: Vec<String>,
}
impl Identity {
    pub fn require(&self, permission: &str) -> Result<()> {
        if self.permissions.iter().any(|p| p == "*" || p == permission) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
}
#[derive(Serialize, FromRow)]
pub struct Role {
    pub entity_id: i64,
    pub id: Uuid,
    pub name: String,
    pub permissions: Vec<String>,
    pub system: bool,
}
#[derive(Serialize, FromRow)]
pub struct Audit {
    pub id: Uuid,
    pub actor_id: Option<Uuid>,
    pub action: String,
    pub entity_id: Uuid,
    pub details: serde_json::Value,
    pub created_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserInput {
    pub email: String,
    pub name: String,
    pub role_id: Uuid,
    #[serde(default)]
    pub password: Option<String>,
    pub active: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleInput {
    pub name: String,
    pub permissions: Vec<String>,
}
impl Service {
    pub async fn audit(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        actor: Option<Uuid>,
        action: &str,
        id: Uuid,
        details: serde_json::Value,
    ) -> Result<()> {
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(actor).bind(action).bind(id).bind(details).execute(&mut **tx).await?;
        infra_events::record(
            tx,
            action,
            serde_json::json!({"actor_id":actor,"entity_id":id}),
        )
        .await?;
        Ok(())
    }
    async fn identity(&self, id: Uuid) -> Result<Identity> {
        let user:Admin=sqlx::query_as("SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1 AND active").bind(id).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)?;
        let permissions = sqlx::query_scalar("SELECT permissions FROM admin_iam.roles WHERE id=$1")
            .bind(user.role_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(Identity { user, permissions })
    }
    pub async fn authenticate(&self, token: &str) -> Result<Identity> {
        let id: Uuid = sqlx::query_scalar(
            "SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1 AND expires_at>now()",
        )
        .bind(infra_auth::digest(token))
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;
        self.identity(id).await
    }
    pub async fn login(&self, input: Credentials) -> Result<(Identity, String)> {
        let (email, kind) = infra_auth::identifier(&input.email)?;
        if kind != "email" {
            return Err(Error::Invalid("Admin login requires an email".into()));
        }
        infra_auth::rate_limit(&self.pool, &format!("admin-login:{email}"), 10).await?;
        let row: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT id,password_hash FROM admin_iam.admin_users WHERE email=$1 AND active",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await?;
        let hash = row
            .as_ref()
            .map(|r| r.1.clone())
            .unwrap_or_else(|| self.security.dummy_hash.clone());
        if !infra_auth::verify_password(input.password, hash.clone()).await? {
            return Err(Error::Unauthorized);
        }
        let (id, _) = row.ok_or(Error::Unauthorized)?;
        let mut tx = self.pool.begin().await?;
        let current: Option<String> = sqlx::query_scalar(
            "SELECT password_hash FROM admin_iam.admin_users WHERE id=$1 AND active FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if current != Some(hash) {
            return Err(Error::Unauthorized);
        }
        let token = infra_auth::token();
        sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '8 hours')").bind(infra_auth::digest(&token)).bind(id).execute(&mut *tx).await?;
        Self::audit(
            &mut tx,
            Some(id),
            "admin.logged_in",
            id,
            serde_json::json!({}),
        )
        .await?;
        tx.commit().await?;
        Ok((self.identity(id).await?, token))
    }
    pub async fn logout(&self, token: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let id: Option<Uuid> = sqlx::query_scalar(
            "DELETE FROM admin_iam.sessions WHERE token_hash=$1 RETURNING admin_id",
        )
        .bind(infra_auth::digest(token))
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = id {
            Self::audit(
                &mut tx,
                Some(id),
                "admin.logged_out",
                id,
                serde_json::json!({}),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn users(&self, who: &Identity) -> Result<Vec<Admin>> {
        who.require("iam.users.read")?;
        Ok(sqlx::query_as("SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users ORDER BY created_at,id LIMIT 500").fetch_all(&self.pool).await?)
    }
    pub async fn roles(&self, who: &Identity) -> Result<Vec<Role>> {
        who.require("iam.roles.read")?;
        Ok(
            sqlx::query_as("SELECT * FROM admin_iam.roles ORDER BY system DESC,name LIMIT 500")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn audits(&self, who: &Identity) -> Result<Vec<Audit>> {
        self.search_audits(who, "", 0).await
    }
    pub async fn search_audits(&self, who: &Identity, q: &str, offset: i64) -> Result<Vec<Audit>> {
        who.require("iam.audit.read")?;
        if q.len() > 200 || !(0..=1000000).contains(&offset) {
            return Err(Error::Invalid("Invalid audit search".into()));
        }
        Ok(sqlx::query_as("SELECT * FROM admin_iam.audit_log WHERE $1='' OR strpos(lower(action),lower($1))>0 OR strpos(lower(details::text),lower($1))>0 OR strpos(COALESCE(actor_id::text,''),$1)>0 OR strpos(entity_id::text,$1)>0 ORDER BY created_at DESC,id LIMIT 200 OFFSET $2").bind(q).bind(offset).fetch_all(&self.pool).await?)
    }

    async fn mutation(
        &self,
        who: &Identity,
        permission: &str,
    ) -> Result<sqlx::Transaction<'_, sqlx::Postgres>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(1001)")
            .execute(&mut *tx)
            .await?;
        let current:Option<Vec<String>>=sqlx::query_scalar("SELECT r.permissions FROM admin_iam.admin_users u JOIN admin_iam.roles r ON r.id=u.role_id WHERE u.id=$1 AND u.active").bind(who.user.id).fetch_optional(&mut *tx).await?;
        let permissions = current.ok_or(Error::Unauthorized)?;
        if !permissions.iter().any(|p| p == "*" || p == permission) {
            return Err(Error::Forbidden);
        }
        Ok(tx)
    }
    async fn protect_last(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) -> Result<()> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM admin_iam.admin_users WHERE active AND role_id=$1",
        )
        .bind(SUPER)
        .fetch_one(&mut **tx)
        .await?;
        if count == 0 {
            return Err(Error::Invalid(
                "At least one active super administrator must remain".into(),
            ));
        }
        Ok(())
    }
    pub async fn save_user(
        &self,
        who: &Identity,
        id: Option<Uuid>,
        input: UserInput,
    ) -> Result<Admin> {
        who.require("iam.users.write")?;
        let (email, kind) = infra_auth::identifier(&input.email)?;
        if kind != "email" {
            return Err(Error::Invalid("Admin users require an email".into()));
        }
        infra_auth::bounded(&input.name, "Name", 120, true)?;
        if id.is_none() && input.password.is_none() {
            return Err(Error::Invalid("Password is required".into()));
        }
        let hash = if let Some(p) = input.password {
            Some(infra_auth::hash_password(p).await?)
        } else {
            None
        };
        let mut tx = self.mutation(who, "iam.users.write").await?;
        // Only a super administrator may grant/revoke the protected role, or manage peers holding it.
        let old: Option<Admin> = if let Some(id) = id {
            Some(sqlx::query_as("SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?)
        } else {
            None
        };
        let actor_role: Uuid =
            sqlx::query_scalar("SELECT role_id FROM admin_iam.admin_users WHERE id=$1")
                .bind(who.user.id)
                .fetch_one(&mut *tx)
                .await?;
        if (input.role_id == SUPER || old.as_ref().is_some_and(|u| u.role_id == SUPER))
            && actor_role != SUPER
        {
            return Err(Error::Forbidden);
        }
        // Delegated user managers cannot assign a role with permissions they do not hold.
        let assigned: Vec<String> =
            sqlx::query_scalar("SELECT permissions FROM admin_iam.roles WHERE id=$1")
                .bind(input.role_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        let actor: Vec<String> =
            sqlx::query_scalar("SELECT permissions FROM admin_iam.roles WHERE id=$1")
                .bind(actor_role)
                .fetch_one(&mut *tx)
                .await?;
        if !actor.iter().any(|p| p == "*") && assigned.iter().any(|p| !actor.contains(p)) {
            return Err(Error::Forbidden);
        }
        let uid = id.unwrap_or_else(Uuid::new_v4);
        let user: Admin = if id.is_some() {
            sqlx::query_as("UPDATE admin_iam.admin_users SET email=$1,name=$2,role_id=$3,active=$4,password_hash=COALESCE($5,password_hash) WHERE id=$6 RETURNING id,entity_id,email,name,role_id,active,created_at").bind(email).bind(input.name).bind(input.role_id).bind(input.active).bind(&hash).bind(uid).fetch_one(&mut *tx).await?
        } else {
            sqlx::query_as("INSERT INTO admin_iam.admin_users(id,email,name,role_id,active,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,entity_id,email,name,role_id,active,created_at").bind(uid).bind(email).bind(input.name).bind(input.role_id).bind(input.active).bind(&hash).fetch_one(&mut *tx).await?
        };
        Self::protect_last(&mut tx).await?;
        if id.is_some() {
            sqlx::query("DELETE FROM admin_iam.sessions WHERE admin_id=$1")
                .bind(uid)
                .execute(&mut *tx)
                .await?;
        }
        Self::audit(
            &mut tx,
            Some(who.user.id),
            if id.is_some() {
                "admin.user_updated"
            } else {
                "admin.user_created"
            },
            uid,
            serde_json::json!({"before":old,"after":user}),
        )
        .await?;
        tx.commit().await?;
        Ok(user)
    }
    pub async fn delete_user(&self, who: &Identity, id: Uuid) -> Result<()> {
        let mut tx = self.mutation(who, "iam.users.write").await?;
        let old:Admin=sqlx::query_as("SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        let actor: Uuid =
            sqlx::query_scalar("SELECT role_id FROM admin_iam.admin_users WHERE id=$1")
                .bind(who.user.id)
                .fetch_one(&mut *tx)
                .await?;
        if old.role_id == SUPER && actor != SUPER {
            return Err(Error::Forbidden);
        }
        // Soft deletion preserves the actor references required by the audit trail.
        sqlx::query("UPDATE admin_iam.admin_users SET active=false WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Self::protect_last(&mut tx).await?;
        sqlx::query("DELETE FROM admin_iam.sessions WHERE admin_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Self::audit(
            &mut tx,
            Some(who.user.id),
            "admin.user_deleted",
            id,
            serde_json::json!({"before":old,"active":false}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn save_role(
        &self,
        who: &Identity,
        id: Option<Uuid>,
        input: RoleInput,
    ) -> Result<Role> {
        infra_auth::bounded(&input.name, "Role name", 80, true)?;
        if input.permissions.len() > 500 || input.permissions.iter().any(|p| !valid_permission(p)) {
            return Err(Error::Invalid("Unknown or duplicate permissions".into()));
        }
        let mut tx = self.mutation(who, "iam.roles.write").await?;
        let actor:Vec<String>=sqlx::query_scalar("SELECT r.permissions FROM admin_iam.admin_users u JOIN admin_iam.roles r ON r.id=u.role_id WHERE u.id=$1").bind(who.user.id).fetch_one(&mut *tx).await?;
        if !actor.iter().any(|p| p == "*") && input.permissions.iter().any(|p| !actor.contains(p)) {
            return Err(Error::Forbidden);
        }
        let old: Option<Role> = if let Some(id) = id {
            Some(
                sqlx::query_as("SELECT * FROM admin_iam.roles WHERE id=$1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or(Error::NotFound)?,
            )
        } else {
            None
        };
        if old.as_ref().is_some_and(|r| r.system) {
            return Err(Error::Invalid("Built-in roles cannot be changed".into()));
        }
        let rid = id.unwrap_or_else(Uuid::new_v4);
        let role=sqlx::query_as("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,permissions=EXCLUDED.permissions RETURNING *").bind(rid).bind(input.name).bind(input.permissions).fetch_one(&mut *tx).await?;
        Self::audit(
            &mut tx,
            Some(who.user.id),
            if id.is_some() {
                "admin.role_updated"
            } else {
                "admin.role_created"
            },
            rid,
            serde_json::json!({"before":old,"after":role}),
        )
        .await?;
        tx.commit().await?;
        Ok(role)
    }
    pub async fn delete_role(&self, who: &Identity, id: Uuid) -> Result<()> {
        let mut tx = self.mutation(who, "iam.roles.write").await?;
        let old: Role = sqlx::query_as("SELECT * FROM admin_iam.roles WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        if old.system {
            return Err(Error::Invalid("Built-in roles cannot be removed".into()));
        }
        sqlx::query("DELETE FROM admin_iam.roles WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Self::audit(
            &mut tx,
            Some(who.user.id),
            "admin.role_deleted",
            id,
            serde_json::json!({"before":old}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    /// Explicit demo setup operation: preserve account IDs and audit history while
    /// making the configured account the only active administrator.
    pub async fn enforce_demo_admin(&self, email: &str, password: String) -> Result<Uuid> {
        let (email, kind) = infra_auth::identifier(email)?;
        if kind != "email" {
            return Err(Error::Invalid("Email required".into()));
        }
        let hash = infra_auth::hash_password(password).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(1001)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("LOCK TABLE admin_iam.admin_users IN EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await?;
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM admin_iam.admin_users ORDER BY (email=$1) DESC,created_at,id LIMIT 1 FOR UPDATE"
        ).bind(&email).fetch_optional(&mut *tx).await?;
        let id = existing.unwrap_or_else(Uuid::new_v4);
        sqlx::query("UPDATE admin_iam.admin_users SET active=false WHERE id<>$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if existing.is_some() {
            sqlx::query("UPDATE admin_iam.admin_users SET email=$1,password_hash=$2,role_id=$3,active=true WHERE id=$4")
                .bind(&email).bind(hash).bind(SUPER).bind(id).execute(&mut *tx).await?;
        } else {
            sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id,active) VALUES($1,$2,'Store administrator',$3,$4,true)")
                .bind(id).bind(&email).bind(hash).bind(SUPER).execute(&mut *tx).await?;
        }
        sqlx::query("DELETE FROM admin_iam.sessions")
            .execute(&mut *tx)
            .await?;
        Self::audit(
            &mut tx,
            None,
            "admin.demo_credentials_enforced",
            id,
            serde_json::json!({"role_id":SUPER}),
        )
        .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn seed(&self, email: &str, password: String) -> Result<Uuid> {
        let (email, kind) = infra_auth::identifier(email)?;
        if kind != "email" {
            return Err(Error::Invalid("Email required".into()));
        }
        let hash = infra_auth::hash_password(password).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(1001)")
            .execute(&mut *tx)
            .await?;
        let existing: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_iam.admin_users)")
                .fetch_one(&mut *tx)
                .await?;
        if existing {
            return Err(Error::Invalid("Bootstrap is only available before the first admin exists; use admin user management".into()));
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Store administrator',$3,$4)").bind(id).bind(email).bind(hash).bind(SUPER).execute(&mut *tx).await?;
        Self::audit(
            &mut tx,
            None,
            "admin.bootstrapped",
            id,
            serde_json::json!({"role_id":SUPER}),
        )
        .await?;
        tx.commit().await?;
        Ok(id)
    }
}
