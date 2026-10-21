//! One-shot reporting refresh for staging seeds and scheduled operations.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _telemetry = infra_observability::init();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    let client = api_gateway::analytics::Client::new(
        std::env::var("CLICKHOUSE_URL")?,
        std::env::var("CLICKHOUSE_USER")?,
        std::env::var("CLICKHOUSE_PASSWORD")?,
    );
    client.initialize().await?;
    for _ in 0..30 {
        if client.sync_reports(&pool).await? {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err("Reporting sync remained busy for 60 seconds".into())
}
