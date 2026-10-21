//! Dedicated reporting/analytics process; failures do not terminate commerce HTTP.
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    api_gateway::analytics_worker::run().await
}
