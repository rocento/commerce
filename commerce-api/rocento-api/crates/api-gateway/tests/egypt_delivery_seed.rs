//! Exercise the Python demo seed through the actual admin API and PostgreSQL.
use api_gateway::identity::App;
use domain_inventory::areas::Pin;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

async fn check_network(pool: PgPool, store: &str) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../");
    let preset: Value = serde_json::from_slice(
        &std::fs::read(root.join(format!("commerce-demo/{store}/preset.json"))).unwrap(),
    )
    .unwrap();
    let security = infra_auth::Security::new(
        "egypt-seed-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'seed@example.test','Seed test','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest("egypt-seed-test")).bind(actor).execute(&pool).await.unwrap();
    let item = &preset["products"][0];
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({
                "name":"Seed category", "slug":item["category"], "parent_id":null,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let product = catalog.save_product(None, serde_json::from_value(json!({
        "sku":item["sku"], "slug":item["slug"], "name":item["name"], "description":"Synthetic demo seed test",
        "price":"3.00", "currency":"USD", "unit":"each", "category_id":category.id,
        "attributes":{}, "media_ids":[], "active":true, "in_stock":true,
    })).unwrap()).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: app.clone(),
        catalog,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    })
    .merge(api_gateway::cart::router(app.clone()));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let script = r#"
import importlib.util, json, sys
from pathlib import Path
root=Path(sys.argv[1])
sys.path.insert(0,str(root/'commerce-assets/demo'))
from demo_seed import Client
spec=importlib.util.spec_from_file_location('delivery_seed',root/'commerce-assets/demo/seed-delivery-areas.py')
seed=importlib.util.module_from_spec(spec); spec.loader.exec_module(seed)
f=json.load(sys.stdin)
c=Client(f['origin']); c.http.addheaders=[('Cookie','admin_session=egypt-seed-test')]
first=seed.seed(c,f['store'],expand_coverage=True)
second=seed.seed(c,f['store'],expand_coverage=True)
assert first['areas_created']==43 and first['inventory_assignments']==53
assert second['areas_created']==0 and second['inventory_assignments']==0
"#;
    let mut child = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"origin":origin,"store":store})
                .to_string()
                .as_bytes(),
        )
        .await
        .unwrap();
    let result = child.wait_with_output().await.unwrap();
    server.abort();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let areas = app.cart.inventory.areas().await.unwrap();
    assert_eq!(areas.len(), 43);
    assert_eq!(app.cart.inventory.sources().await.unwrap().len(), 54); // includes original default
    assert_eq!(app.cart.inventory.stocks().await.unwrap().len(), 44);
    for area in &areas {
        domain_inventory::areas::validate_boundary(area.input.boundary.as_ref().unwrap()).unwrap();
        let delivery = app
            .cart
            .inventory
            .delivery(Some(Pin {
                latitude: area.input.center_lat,
                longitude: area.input.center_lng,
            }))
            .await
            .unwrap();
        assert!(delivery.deliverable, "{}", area.input.name);
        assert!(
            app.cart
                .inventory
                .area_available(delivery.area_id.unwrap(), product.id)
                .await
                .unwrap()
                > 0
        );
    }
    // A rural pin outside the illustrative city zones must not claim delivery.
    assert!(
        !app.cart
            .inventory
            .delivery(Some(Pin {
                latitude: 22.5,
                longitude: 26.0
            }))
            .await
            .unwrap()
            .deliverable
    );
    // Local stock runs out first; the regional source supplies the remainder.
    let area = areas
        .iter()
        .find(|a| a.input.name == "Egypt demo — Aswan")
        .unwrap();
    let stock = area.input.stocks[0].stock_id;
    let primary: (Uuid,i32) = sqlx::query_as("SELECT i.source_id,i.quantity FROM inventory.source_items i JOIN inventory.source_stock_links l USING(source_id) WHERE l.stock_id=$1 AND i.product_id=$2 ORDER BY l.priority LIMIT 1")
        .bind(stock).bind(product.id).fetch_one(&pool).await.unwrap();
    let session = app.cart.open(None, "").await.unwrap();
    let guest = session.guest_token.unwrap();
    app.cart
        .set_delivery(
            None,
            &guest,
            Some(Pin {
                latitude: area.input.center_lat,
                longitude: area.input.center_lng,
            }),
        )
        .await
        .unwrap();
    app.cart
        .set(None, &guest, product.clone(), primary.1 + 1, true)
        .await
        .unwrap();
    let allocations: Vec<(Uuid,i32)> = sqlx::query_as("SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1 ORDER BY quantity DESC")
        .bind(session.cart.id).fetch_all(&pool).await.unwrap();
    assert_eq!(allocations.len(), 2);
    assert!(allocations.contains(&(primary.0, primary.1)));
    assert_eq!(
        allocations.iter().map(|(_, q)| q).sum::<i32>(),
        primary.1 + 1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn grocery_egypt_network(pool: PgPool) {
    check_network(pool, "grocery").await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn jewelry_egypt_network(pool: PgPool) {
    check_network(pool, "jewelry").await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn electronics_egypt_network(pool: PgPool) {
    check_network(pool, "electronics").await;
}
