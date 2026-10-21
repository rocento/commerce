#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.iter()
            .position(|v| v == name)
            .and_then(|n| args.get(n + 1))
            .cloned()
    };
    let email=value("--email").ok_or("Usage: seed-admin --email EMAIL [--password PASSWORD]; prefer BOOTSTRAP_ADMIN_PASSWORD environment variable")?;
    let password = value("--password")
        .or_else(|| std::env::var("BOOTSTRAP_ADMIN_PASSWORD").ok())
        .ok_or("Password required")?;
    let pool = infra_db::connect(&std::env::var("DATABASE_URL")?).await?;
    infra_db::migrate(&pool).await?;
    let security = infra_auth::Security::new(
        std::env::var("AUTH_SECRET")?,
        "http://localhost:5173".into(),
        false,
    )
    .await?;
    let service = domain_admin_iam::Service { pool, security };
    if args.iter().any(|arg| arg == "--enforce-demo-admin") {
        let id = service.enforce_demo_admin(&email, password).await?;
        println!("Enforced sole demo administrator {id} ({email})");
    } else {
        let id = service.seed(&email, password).await?;
        println!("Created initial super administrator {id} ({email})");
    }
    Ok(())
}
