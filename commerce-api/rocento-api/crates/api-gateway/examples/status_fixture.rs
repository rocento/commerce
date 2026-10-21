//! Minimal local test host for real segment and notification browser workflows.
//! Requires a disposable database named commerce_status_browser and explicit credentials.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database = std::env::var("DATABASE_URL")?;
    let url = reqwest::Url::parse(&database)?;
    if url.path() != "/commerce_status_browser"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
    {
        return Err("Use only the local disposable commerce_status_browser database".into());
    }
    let pool = infra_db::connect(&database).await?;
    infra_db::migrate(&pool).await?;
    let mut security = infra_auth::Security::new(
        "isolated-browser-fixture-secret-at-least-32".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await?;
    security.queued_notifications = true;
    let app = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec![
            "http://localhost:5174".into(),
            "http://127.0.0.1:5176".into(),
        ],
    );
    if sqlx::query_scalar::<_, i64>("SELECT count(*) FROM admin_iam.admin_users")
        .fetch_one(&pool)
        .await?
        == 0
    {
        app.admins
            .seed(
                &std::env::var("ADMIN_TEST_EMAIL")?,
                std::env::var("ADMIN_TEST_PASSWORD")?,
            )
            .await?;
        for group in ["gold", "general"] {
            sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,customer_group) VALUES($1,$2,'email','unused',$3)")
                .bind(uuid::Uuid::new_v4()).bind(format!("{group}@example.test")).bind(group).execute(&pool).await?;
        }
    }
    let transport = api_gateway::notifications::Mailpit::new(
        &std::env::var("MAILPIT_TEST_URL")?,
        "store@example.test",
    )?;
    tokio::spawn(api_gateway::notifications::worker(pool, transport));
    let router = api_gateway::router()
        .merge(api_gateway::identity::router(app.clone()))
        .merge(api_gateway::segments::router(app.clone()))
        .merge(api_gateway::attributes::router(app));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18085").await?;
    println!("Isolated fixture listening on 127.0.0.1:18085");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
