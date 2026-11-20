use rocento_onboard_api::{database, provisioning, provisioning_executor::HostExecutor};
use std::time::Duration;
use tokio::{sync::watch, task::JoinSet};

fn concurrency(value: Option<&str>) -> Result<usize, &'static str> {
    let count = value
        .unwrap_or("4")
        .parse::<usize>()
        .map_err(|_| "invalid PROVISIONING_CONCURRENCY")?;
    if !(1..=8).contains(&count) {
        return Err("PROVISIONING_CONCURRENCY must be 1..8");
    }
    Ok(count)
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt().with_env_filter("info").init();
    std::env::var("DATABASE_URL")?;
    let db = database::connect()?;
    if std::env::args().any(|a| a == "--once") {
        provisioning::run_once(&db, &HostExecutor).await?;
        db.close().await;
        return Ok(());
    }
    let count = concurrency(std::env::var("PROVISIONING_CONCURRENCY").ok().as_deref())?;
    let (stop, receiver) = watch::channel(false);
    let mut workers = JoinSet::new();
    for slot in 0..count {
        let db = db.clone();
        let mut receiver = receiver.clone();
        workers.spawn(async move {
            while !*receiver.borrow() {
                // Finish an owned checkpoint before stopping; dropping an in-flight
                // remote command would create an unnecessarily ambiguous outcome.
                let delay = match provisioning::run_once(&db, &HostExecutor).await {
                    Ok(true) => Duration::from_millis(250),
                    Ok(false) => Duration::from_secs(5),
                    Err(error) => {
                        tracing::error!(slot, %error, "provisioning iteration failed; durable state retained");
                        Duration::from_secs(5)
                    }
                };
                tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = receiver.changed() => {} }
            }
        });
    }
    tracing::info!(concurrency = count, "provisioning workers started");
    let mut failure = None;
    tokio::select! {
        _ = shutdown() => {},
        result = workers.join_next() => { failure = result.and_then(Result::err); }
    }
    stop.send_replace(true);
    while let Some(result) = workers.join_next().await {
        if let Err(error) = result {
            failure = Some(error);
        }
    }
    db.close().await;
    if let Some(error) = failure {
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::concurrency;
    #[test]
    fn worker_capacity_is_bounded() {
        assert_eq!(concurrency(None), Ok(4));
        for count in ["1", "4", "8"] {
            assert!(concurrency(Some(count)).is_ok());
        }
        for count in ["0", "9", "-1", "", "unbounded"] {
            assert!(concurrency(Some(count)).is_err());
        }
    }
}
