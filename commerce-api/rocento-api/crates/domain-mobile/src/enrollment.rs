//! Owner-approved internal testing enrollment. Store attestation is a separate release gate.
use crate::{
    service::{Access, Service},
    *,
};
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invite {
    pub identity_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enroll {
    pub code: String,
    pub merchant_id: Uuid,
    pub platform: Platform,
    pub identifier: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Renew {
    pub device_token: String,
    pub merchant_id: Uuid,
    pub platform: Platform,
    pub identifier: String,
}
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct NativeIdentity {
    pub id: Uuid,
    pub platform: String,
    pub identifier: String,
}
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: Uuid,
    pub platform: String,
    pub identifier: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub device_id: Uuid,
    pub device_token: Option<String>,
    pub access_token: String,
    pub expires_in: i32,
    pub merchant_id: Uuid,
    pub platform: Platform,
    pub identifier: String,
    pub environment: &'static str,
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn valid(token: &str) -> Result<()> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
impl Service {
    pub async fn native_identities(
        &self,
        merchant: Uuid,
        actor: Uuid,
    ) -> Result<Vec<NativeIdentity>> {
        self.authorize(merchant, actor, Access::Publish).await?;
        Ok(sqlx::query_as("SELECT id,platform,identifier FROM mobile.app_identities WHERE merchant_id=$1 AND environment='production' AND active ORDER BY platform")
            .bind(merchant).fetch_all(&self.pool).await?)
    }
    pub async fn invite_device(
        &self,
        merchant: Uuid,
        actor: Uuid,
        identity: Uuid,
    ) -> Result<Value> {
        let mut tx = self.write(merchant, actor, Access::Publish).await?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mobile.app_identities WHERE id=$1 AND merchant_id=$2 AND environment='production' AND active)")
            .bind(identity).bind(merchant).fetch_one(&mut *tx).await?;
        if !exists {
            return Err(Error::NotFound);
        }
        let code = secret();
        sqlx::query("INSERT INTO mobile.device_invitations(token_hash,identity_id,created_by) VALUES($1,$2,$3)")
            .bind(token_hash(&code)).bind(identity).bind(actor).execute(&mut *tx).await?;
        Self::audit(
            &mut tx,
            merchant,
            Environment::Production,
            actor,
            "device.invited",
            json!({"identityId":identity}),
        )
        .await?;
        tx.commit().await?;
        Ok(json!({"code":code,"expiresIn":900}))
    }
    pub async fn enroll_device(&self, input: Enroll) -> Result<Session> {
        valid(&input.code)?;
        let mut tx = self.pool.begin().await?;
        // Membership/identity/merchant locks close deactivation races. Only the owner who
        // issued this one-time code can authorize it; caller identity strings are binding checks.
        let identity: Option<(Uuid,Uuid)> = sqlx::query_as("SELECT i.id,v.created_by FROM mobile.device_invitations v JOIN mobile.app_identities i ON i.id=v.identity_id JOIN mobile.merchants m ON m.id=i.merchant_id JOIN mobile.memberships p ON p.merchant_id=m.id AND p.admin_id=v.created_by JOIN admin_iam.admin_users u ON u.id=p.admin_id WHERE v.token_hash=$1 AND v.used_at IS NULL AND v.expires_at>now() AND i.merchant_id=$2 AND i.platform=$3 AND i.identifier=$4 AND i.environment='production' AND i.active AND m.active AND u.active AND p.role='owner' FOR UPDATE OF v FOR SHARE OF i,m,p,u")
            .bind(token_hash(&input.code)).bind(input.merchant_id).bind(input.platform.as_str()).bind(&input.identifier).fetch_optional(&mut *tx).await?;
        let (identity, issuer) = identity.ok_or(Error::Unauthorized)?;
        sqlx::query("UPDATE mobile.device_invitations SET used_at=now() WHERE token_hash=$1")
            .bind(token_hash(&input.code))
            .execute(&mut *tx)
            .await?;
        let device = Uuid::new_v4();
        let token = secret();
        sqlx::query("INSERT INTO mobile.devices(id,identity_id,token_hash) VALUES($1,$2,$3)")
            .bind(device)
            .bind(identity)
            .bind(token_hash(&token))
            .execute(&mut *tx)
            .await?;
        let access = secret();
        sqlx::query("INSERT INTO mobile.app_sessions(token_hash,identity_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')").bind(token_hash(&access)).bind(identity).bind(device).execute(&mut *tx).await?;
        Self::audit(
            &mut tx,
            input.merchant_id,
            Environment::Production,
            issuer,
            "device.enrolled",
            json!({"deviceId":device,"identityId":identity}),
        )
        .await?;
        tx.commit().await?;
        Ok(Session {
            device_id: device,
            device_token: Some(token),
            access_token: access,
            expires_in: 1800,
            merchant_id: input.merchant_id,
            platform: input.platform,
            identifier: input.identifier,
            environment: "production",
        })
    }
    pub async fn renew_device(&self, input: Renew) -> Result<Session> {
        valid(&input.device_token)?;
        let mut tx = self.pool.begin().await?;
        let context: Option<(Uuid,Uuid)> = sqlx::query_as("SELECT d.id,i.id FROM mobile.devices d JOIN mobile.app_identities i ON i.id=d.identity_id JOIN mobile.merchants m ON m.id=i.merchant_id WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>now() AND i.merchant_id=$2 AND i.platform=$3 AND i.identifier=$4 AND i.environment='production' AND i.active AND m.active FOR UPDATE OF d FOR SHARE OF i,m")
            .bind(token_hash(&input.device_token)).bind(input.merchant_id).bind(input.platform.as_str()).bind(&input.identifier).fetch_optional(&mut *tx).await?;
        let (device, identity) = context.ok_or(Error::Unauthorized)?;
        // One current session per device bounds storage and closes previous access on renewal.
        sqlx::query("DELETE FROM mobile.app_sessions WHERE device_id=$1")
            .bind(device)
            .execute(&mut *tx)
            .await?;
        let access = secret();
        sqlx::query("INSERT INTO mobile.app_sessions(token_hash,identity_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')").bind(token_hash(&access)).bind(identity).bind(device).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Session {
            device_id: device,
            device_token: None,
            access_token: access,
            expires_in: 1800,
            merchant_id: input.merchant_id,
            platform: input.platform,
            identifier: input.identifier,
            environment: "production",
        })
    }
    pub async fn native_devices(&self, merchant: Uuid, actor: Uuid) -> Result<Vec<Device>> {
        self.authorize(merchant, actor, Access::Publish).await?;
        Ok(sqlx::query_as("SELECT d.id,i.platform,i.identifier,d.created_at,d.expires_at,d.revoked_at FROM mobile.devices d JOIN mobile.app_identities i ON i.id=d.identity_id WHERE i.merchant_id=$1 AND i.environment='production' ORDER BY d.created_at DESC,d.id LIMIT 100")
            .bind(merchant).fetch_all(&self.pool).await?)
    }
    pub async fn revoke_device(&self, merchant: Uuid, actor: Uuid, device: Uuid) -> Result<()> {
        let mut tx = self.write(merchant, actor, Access::Publish).await?;
        let result = sqlx::query("UPDATE mobile.devices d SET revoked_at=COALESCE(revoked_at,now()) FROM mobile.app_identities i WHERE d.id=$1 AND i.id=d.identity_id AND i.merchant_id=$2 AND i.environment='production'")
            .bind(device).bind(merchant).execute(&mut *tx).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        sqlx::query("DELETE FROM mobile.app_sessions WHERE device_id=$1")
            .bind(device)
            .execute(&mut *tx)
            .await?;
        Self::audit(
            &mut tx,
            merchant,
            Environment::Production,
            actor,
            "device.revoked",
            json!({"deviceId":device}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn native_asset(
        &self,
        token: &str,
        platform: Platform,
        runtime: &str,
        asset: Uuid,
    ) -> Result<(String, String)> {
        let published = self.resolve(token, platform, runtime, "en").await?;
        if !validation::assets(&published.config).contains(&asset) {
            return Err(Error::NotFound);
        }
        let merchant = published.config["tenantId"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or(Error::Storage)?;
        sqlx::query_as("SELECT object_key,checksum FROM mobile.assets WHERE merchant_id=$1 AND id=$2 AND verified AND object_key=$3 AND content_type='image/png'")
            .bind(merchant).bind(asset).bind(format!("mobile/{merchant}/{asset}")).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
}
