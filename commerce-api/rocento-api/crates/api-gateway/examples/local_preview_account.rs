//! Provision a normal login only in the isolated local preview database.
use std::io::{self, Read};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database = std::env::var("DATABASE_URL")?;
    let url = reqwest::Url::parse(&database)?;
    if url.path() != "/commerce_native_preview"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
    {
        return Err("Only the isolated local preview database is allowed".into());
    }
    let email = std::env::var("PREVIEW_LOGIN_EMAIL")?;
    let mut password = String::new();
    io::stdin().read_to_string(&mut password)?;
    if password.trim().len() < 12 {
        return Err("Password must have at least 12 characters".into());
    }
    let hash = infra_auth::hash_password(password.trim_end().to_owned()).await?;
    let pool = infra_db::connect(&database).await?;
    let mut tx = pool.begin().await?;
    let id: uuid::Uuid = sqlx::query_scalar("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id,active) VALUES($1,$2,'Local preview administrator',$3,$4,true) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=true RETURNING id")
        .bind(uuid::Uuid::new_v4()).bind(email).bind(hash).bind(domain_admin_iam::SUPER).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO mobile.memberships(merchant_id,admin_id,role) VALUES('312f9ac8-4888-4d35-92a0-e5fdb3bf59b8',$1,'owner') ON CONFLICT(merchant_id,admin_id) DO UPDATE SET role='owner'").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    println!("Local preview login ready.");
    Ok(())
}
