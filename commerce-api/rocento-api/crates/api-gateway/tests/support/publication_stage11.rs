use api_gateway::{discoverability, identity, public_commerce::policy::Deployment};
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::io::{BufRead, BufReader};
use uuid::Uuid;

pub struct Renderer(std::process::Child);
impl Drop for Renderer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub async fn fixture(
    pool: &PgPool,
    host: &str,
) -> (String, String, Renderer, tokio::task::JoinHandle<()>) {
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query("UPDATE cms.discoverability_settings SET site_name=$1,enabled=true,indexing_enabled=true,canonical_url=$2").bind(format!("Merchant {host}")).bind(format!("https://{host}/")).execute(pool).await.unwrap();
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../commerce-web/apps/storefront");
    let security = Security::new(
        "publication-secret".repeat(4),
        format!("https://{host}"),
        false,
    )
    .await
    .unwrap();
    let router = discoverability::router_with_deployment(
        identity::App::new(pool.clone(), security, vec![format!("https://{host}")]),
        Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some(format!("https://{host}/")),
            header_override: false,
            html: Some(
                std::fs::read_to_string(
                    std::env::var("PUBLICATION_ARTIFACT_DIR")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|_| root.join("dist"))
                        .join("index.html"),
                )
                .expect("Build storefront first"),
            ),
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let child = std::process::Command::new("node")
        .arg(std::env::var("STAGE11_RENDERER_ENTRY").unwrap_or_else(|_| "server/start.mjs".into()))
        .current_dir(&root)
        .env("PUBLICATION_APPROVED_ORIGIN", format!("https://{host}/"))
        .env("PUBLICATION_INSTALLATION_ID", id.to_string())
        .env("NODE_ENV", "production")
        .env("PUBLICATION_GATEWAY", &gateway)
        .env("PUBLICATION_PORT", "0")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = Renderer(child);
    let mut line = String::new();
    let mut output = BufReader::new(child.0.stdout.take().unwrap());
    output.read_line(&mut line).unwrap();
    std::thread::spawn(move || {
        for line in output.lines() {
            if line.is_err() {
                break;
            }
        }
    });
    let data: Value = serde_json::from_str(&line).expect("Renderer startup");
    (
        format!("http://127.0.0.1:{}", data["port"]),
        gateway,
        child,
        task,
    )
}
pub async fn seed(pool: &PgPool, name: &str) {
    let actor = Uuid::new_v4();
    let theme = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'publisher@example.test','Publisher','!', $2)").bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    let mut published =
        serde_json::to_value(domain_theme::domain::default_configuration()).unwrap();
    published["tokens"]["color.primary"] = json!("#175C39");
    published["global"]["top"][0]["settings"]["text"] = json!("Published merchant announcement");
    let mut draft = published.clone();
    draft["global"]["top"][0]["settings"]["text"] = json!("DO-NOT-PUBLISH draft theme");
    sqlx::query("INSERT INTO theme.themes(id,name,owner_channel,configuration,created_by) VALUES($1,'Public theme','storefront',$2,$3)").bind(theme).bind(draft).bind(actor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO theme.versions(id,theme_id,number,configuration,created_by) VALUES($1,$2,1,$3,$4)").bind(version).bind(theme).bind(published).bind(actor).execute(pool).await.unwrap();
    sqlx::query("UPDATE theme.themes SET published_version=$2 WHERE id=$1")
        .bind(theme)
        .bind(version)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO theme.assignments(channel,theme_id) VALUES('storefront',$1) ON CONFLICT(channel) DO UPDATE SET theme_id=$1").bind(theme).execute(pool).await.unwrap();

    sqlx::query("INSERT INTO catalog.categories(id,name,slug,attributes) VALUES('00000000-0000-0000-0000-000000000001','Fresh fruit','fruit','{\"description\":\"Seasonal fruit selected by our store\"}')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES('00000000-0000-0000-0000-000000000002','APPLE','apples',$1,'Crisp orchard apples, sold by the kilogram.',3.25,'USD','kg','00000000-0000-0000-0000-000000000001','{\"color\":\"Red\",\"secret\":\"DO-NOT-PUBLISH\",\"unknown\":\"DO-NOT-PUBLISH\"}')").bind(name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front) VALUES(gen_random_uuid(),'product','color','Color','text',true),(gen_random_uuid(),'product','secret','Secret','text',false)").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES(gen_random_uuid(),'Cairo',30,31,10)").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.documents(id,key,kind) VALUES('00000000-0000-0000-0000-000000000003','about','page')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003',1,'About our store',$1,gen_random_uuid())").bind(json!([{"kind":"text","heading":"Our produce","text":"We select fresh produce every morning.","image_id":null,"link_label":"Browse fruit","link_url":"/categories/fruit"}])).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',now()-interval '1 hour')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO platform.publication_routes(path,status,target,reason) VALUES('/products/old-apples',301,'/products/apples','Approved rename'),('/products/retired',410,NULL,'Approved permanent removal')").execute(pool).await.unwrap();
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
pub async fn get(base: &str, host: &str, path: &str) -> reqwest::Response {
    client()
        .get(format!("{base}{path}"))
        .header("host", host)
        .send()
        .await
        .unwrap()
}
