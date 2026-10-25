use std::{env, net::SocketAddr, time::Duration};

use rocento_onboard_api::{
    accounts::{Accounts, SecretBox},
    database,
    drafts::Drafts,
    mail::{deliver_one, Mailer},
    routes, AppState,
};
use tokio::{net::TcpListener, time};
use tracing::{error, info};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("API startup failed. Check database and authentication configuration: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let app_env = env::var("APP_ENV").unwrap_or_else(|_| "production".to_owned());
    let production = match app_env.as_str() {
        "development" => false,
        "staging" | "production" => true,
        _ => return Err("APP_ENV must be development, staging, or production".into()),
    };
    let db = database::connect()?;
    let secret_box = match env::var("AUTH_MAIL_KEY") {
        Ok(key) if !key.is_empty() => Some(SecretBox::new(&key)?),
        _ if production => return Err("AUTH_MAIL_KEY is required in production".into()),
        _ => None,
    };
    let accounts = secret_box
        .as_ref()
        .map(|box_| Accounts::new(db.clone(), box_.clone()))
        .transpose()?;
    let mailer = if secret_box.is_some() {
        Some(Mailer::from_env(production)?)
    } else {
        None
    };

    let state = AppState {
        db: db.clone(),
        accounts,
        mailer: mailer.clone(),
        local_auth_enabled: env::var("LOCAL_AUTH_ENABLED").as_deref() == Ok("true"),
        local_customer_token: env::var("LOCAL_CUSTOMER_TOKEN").ok(),
        production,
        request_window: Default::default(),
    };

    if let (Some(box_), Some(mailer)) = (secret_box, mailer) {
        let worker_db = db.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;
                if let Err(error) = deliver_one(&worker_db, &box_, &mailer).await {
                    error!(%error, "mail delivery worker unavailable; pending jobs retained");
                }
            }
        });
    }

    let reservation_db = db.clone();
    tokio::spawn(async move {
        let drafts = Drafts::new(reservation_db);
        let mut interval = time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            match drafts.reconcile_expired_reservations(None).await {
                Ok(0) => {}
                Ok(count) => info!(count, "released expired domain reservations"),
                Err(error) => {
                    error!(%error, "reservation reconciliation failed; expired names remain unavailable")
                }
            }
        }
    });

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4100);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(address).await?;
    info!(%address, "onboarding API listening");
    axum::serve(listener, routes::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
