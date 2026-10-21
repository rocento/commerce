//! Dedicated, resource-limited process using the same backend image.
use api_gateway::engagement;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let health = args.iter().any(|arg| arg == "--health");
    let pool = engagement::connect(&std::env::var("ENGAGEMENT_DATABASE_URL")?, 4).await?;
    if health {
        if !engagement::health(&pool).await? {
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--status") {
        let status: serde_json::Value = sqlx::query_scalar("SELECT jsonb_build_object('pending',count(*) FILTER(WHERE completed_at IS NULL AND failed_at IS NULL),'failed',count(*) FILTER(WHERE failed_at IS NOT NULL),'oldest_pending',min(created_at) FILTER(WHERE completed_at IS NULL AND failed_at IS NULL)) FROM platform.engagement_jobs").fetch_one(&pool).await?;
        println!("{status}");
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--retry-failed") {
        let count = sqlx::query("UPDATE platform.engagement_jobs SET attempts=0,failed_at=NULL,last_error=NULL,available_at=clock_timestamp() WHERE failed_at IS NOT NULL AND completed_at IS NULL").execute(&pool).await?.rows_affected();
        println!("Requeued {count} failed jobs; publication expiry and withdrawal remain enforced");
        return Ok(());
    }
    let _telemetry = infra_observability::init();
    // One commerce connection bounds projection and campaign audience reads.
    let commerce = engagement::connect(&std::env::var("DATABASE_URL")?, 1).await?;
    engagement::migrate(&pool).await?;
    let initialized: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.engagement_installation)")
            .fetch_one(&pool)
            .await?;
    if !initialized {
        return Err(
            "Start the gateway to import engagement data before starting its worker".into(),
        );
    }
    let source_id: uuid::Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation LIMIT 1")
            .fetch_one(&commerce)
            .await?;
    let imported_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT source_id FROM platform.engagement_installation WHERE singleton",
    )
    .fetch_one(&pool)
    .await?;
    if source_id != imported_id {
        return Err("Engagement database belongs to a different store".into());
    }
    let analytics = api_gateway::analytics::Client::new(
        std::env::var("CLICKHOUSE_URL")?,
        std::env::var("CLICKHOUSE_USER")?,
        std::env::var("CLICKHOUSE_PASSWORD")?,
    );
    tokio::spawn(infra_events::publisher(
        pool.clone(),
        std::env::var("NATS_URL")?,
    ));
    let mut projected = tokio::time::Instant::now() - std::time::Duration::from_secs(60);
    let mut cleaned = projected;
    loop {
        if projected.elapsed().as_secs() >= 60 {
            match engagement::project(&commerce, &pool).await {
                Ok(()) => projected = tokio::time::Instant::now(),
                Err(error) => {
                    tracing::warn!(%error,"Engagement projection unavailable; targeting fails closed when stale");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
        if cleaned.elapsed().as_secs() >= 3600 {
            sqlx::query("DELETE FROM platform.engagement_jobs WHERE id IN (SELECT id FROM platform.engagement_jobs WHERE completed_at<clock_timestamp()-interval '7 days' ORDER BY completed_at LIMIT 10000)").execute(&pool).await?;
            sqlx::query("DELETE FROM platform.rate_limits WHERE window_start<clock_timestamp()-interval '1 day'").execute(&pool).await?;
            cleaned = tokio::time::Instant::now();
        }
        sqlx::query("UPDATE platform.engagement_worker_state SET heartbeat_at=clock_timestamp() WHERE singleton").execute(&pool).await?;
        // Single bounded worker: no concurrent fan-out competing with checkout.
        match engagement::process_one_with_commerce(&pool, &commerce, Some(&analytics)).await {
            Ok(true) => {}
            Ok(false) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
            Err(error) => {
                tracing::warn!(%error,"Engagement job failed; durable queue retained");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}
