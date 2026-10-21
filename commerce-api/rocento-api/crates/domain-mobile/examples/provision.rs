//! Trusted operator tool; DATABASE_URL must reference the intended control-plane database.
//! No signing keys or customer/admin passwords are accepted or written by this tool.
use domain_mobile::{
    service::{Access, Service},
    Environment,
};
use serde_json::json;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err("Usage: provision MERCHANT_UUID OWNER_UUID ios|android APP_IDENTIFIER STORE_ACCOUNT_REFERENCE (use internal-testing:NAME only for internal builds)".into());
    }
    let merchant = Uuid::parse_str(&args[0])?;
    let actor = Uuid::parse_str(&args[1])?;
    let platform = &args[2];
    let identifier = &args[3];
    let reference = &args[4];
    if !["ios", "android"].contains(&platform.as_str())
        || identifier.len() > 255
        || !identifier.contains('.')
        || !identifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._".contains(&b))
        || reference.is_empty()
        || reference.len() > 256
        || reference.chars().any(char::is_control)
    {
        return Err(
            "Invalid platform, application identifier or opaque store account reference".into(),
        );
    }
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;
    Service { pool: pool.clone() }
        .authorize(merchant, actor, Access::Publish)
        .await?;
    let mut tx = pool.begin().await?;
    let allowed:Option<Uuid>=sqlx::query_scalar("SELECT m.id FROM mobile.merchants m JOIN mobile.memberships p ON p.merchant_id=m.id JOIN admin_iam.admin_users u ON u.id=p.admin_id WHERE m.id=$1 AND u.id=$2 AND m.active AND u.active AND p.role='owner' FOR UPDATE OF m FOR SHARE OF p,u")
        .bind(merchant).bind(actor).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Err("Active merchant owner required".into());
    }
    let id = Uuid::new_v4();
    let created=sqlx::query("INSERT INTO mobile.app_identities(id,merchant_id,environment,platform,identifier,store_account_ref) VALUES($1,$2,'production',$3,$4,$5) ON CONFLICT DO NOTHING")
        .bind(id).bind(merchant).bind(platform).bind(identifier).bind(reference).execute(&mut *tx).await?.rows_affected()>0;
    let current:Option<Uuid>=sqlx::query_scalar("SELECT id FROM mobile.app_identities WHERE merchant_id=$1 AND environment='production' AND platform=$2 AND identifier=$3 AND store_account_ref=$4 AND active")
        .bind(merchant).bind(platform).bind(identifier).bind(reference).fetch_optional(&mut *tx).await?;
    let current = current
        .ok_or("Existing identity differs or is inactive; refusing to replace its binding")?;
    if created {
        sqlx::query("INSERT INTO mobile.audit_events(id,merchant_id,environment,actor_id,action,details) VALUES($1,$2,$3,$4,'identity.provisioned',$5)")
            .bind(Uuid::new_v4()).bind(merchant).bind(Environment::Production.as_str()).bind(actor).bind(json!({"identityId":current,"platform":platform,"identifier":identifier})).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    println!("Production identity {current}: {platform} {identifier}");
    Ok(())
}
