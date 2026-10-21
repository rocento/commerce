//! Local-only native preview acceptance host, backed by a disposable database.
use serde_json::{json, Value};
use uuid::Uuid;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database = std::env::var("DATABASE_URL")?;
    let url = reqwest::Url::parse(&database)?;
    if url.path() != "/commerce_native_preview"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
    {
        return Err("Use only the local disposable commerce_native_preview database".into());
    }
    let pool = infra_db::connect(&database).await?;
    infra_db::migrate(&pool).await?;
    let merchant = Uuid::parse_str("312f9ac8-4888-4d35-92a0-e5fdb3bf59b8")?;
    sqlx::query("INSERT INTO mobile.merchants(id,name,entitlements) VALUES($1,'Native preview acceptance',$2) ON CONFLICT(id) DO NOTHING")
        .bind(merchant).bind(json!({"wishlist":true,"locationPicker":true})).execute(&pool).await?;
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Preview acceptance','unused',$3)")
        .bind(actor).bind(format!("{actor}@preview.test")).bind(domain_admin_iam::SUPER).execute(&pool).await?;
    sqlx::query("INSERT INTO mobile.memberships(merchant_id,admin_id,role) VALUES($1,$2,'owner')")
        .bind(merchant)
        .bind(actor)
        .execute(&pool)
        .await?;
    let cookie = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '2 hours')")
        .bind(infra_auth::digest(&cookie)).bind(actor).execute(&pool).await?;
    let mut config: Value = serde_json::from_str(include_str!(
        "../../domain-mobile/contract/v1/fixtures/merchant-1.json"
    ))?;
    config["tenantId"] = json!(merchant);
    config["configVersion"] = json!(0);
    config["screens"]["home"]["sections"] =
        json!([{"id":"live-copy","type":"richText","props":{"textKey":"live_copy"}}]);
    config["localization"]["messages"]["en"]["live_copy"] = json!("Native preview ready");
    config["localization"]["messages"]["ar"]["live_copy"] = json!("المعاينة الأصلية جاهزة");
    let logo = Uuid::parse_str(config["brand"]["logoAssetId"].as_str().unwrap())?;
    sqlx::query("INSERT INTO mobile.assets(id,merchant_id,url,kind,verified,checksum) VALUES($1,$2,'https://assets.example.test/fixture.png','image',true,$3) ON CONFLICT(id) DO NOTHING")
        .bind(logo).bind(merchant).bind("a".repeat(64)).execute(&pool).await?;
    sqlx::query("INSERT INTO mobile.config_drafts(merchant_id,environment,revision,config,updated_by) VALUES($1,'production',1,$2,$3) ON CONFLICT(merchant_id,environment) DO NOTHING")
        .bind(merchant).bind(config).bind(actor).execute(&pool).await?;
    std::fs::write(
        std::env::var("PREVIEW_FIXTURE_STATE")?,
        serde_json::to_vec(&json!({"merchantId":merchant,"adminCookie":cookie}))?,
    )?;
    let security = infra_auth::Security::new(
        "isolated-native-preview-fixture-secret-32-chars".into(),
        "http://127.0.0.1:5194".into(),
        false,
    )
    .await?;
    let app = api_gateway::identity::App::new(
        pool,
        security,
        vec![
            "http://127.0.0.1:5194".into(),
            "http://localhost:5194".into(),
        ],
    );
    // Optional local private storage enables real image upload/preview acceptance.
    let media = if let Ok(endpoint) = std::env::var("S3_ENDPOINT") {
        let storage_url = reqwest::Url::parse(&endpoint)?;
        if !matches!(storage_url.host_str(), Some("localhost" | "127.0.0.1")) {
            return Err("Fixture storage must be local".into());
        }
        let store = infra_media::Store::new(
            endpoint,
            &std::env::var("S3_ACCESS_KEY")?,
            &std::env::var("S3_SECRET_KEY")?,
        )
        .map_err(|e| e.to_string())?;
        store.initialize().await.map_err(|e| e.to_string())?;
        Some(store)
    } else {
        None
    };
    let router = api_gateway::identity::router(app.clone())
        .merge(api_gateway::mobile::router_with_media(app, media));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18094").await?;
    println!("Isolated native preview fixture listening on 127.0.0.1:18094");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
