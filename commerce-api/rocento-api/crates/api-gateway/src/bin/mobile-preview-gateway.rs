//! Preview-only sidecar. No commerce workers or automatic schema migrations.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    let security = infra_auth::Security::new(
        std::env::var("AUTH_SECRET")?,
        std::env::var("STOREFRONT_URL")?,
        true,
    )
    .await?;
    let identity =
        api_gateway::identity::App::new(pool, security, vec!["https://apps.rocento.com".into()]);
    let media = infra_media::Store::new(
        std::env::var("S3_ENDPOINT")?,
        &std::env::var("S3_ACCESS_KEY")?,
        &std::env::var("S3_SECRET_KEY")?,
    )
    .map_err(|e| e.to_string())?;
    let router = api_gateway::mobile::router_with_media(identity, Some(media));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:9085").await?;
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
