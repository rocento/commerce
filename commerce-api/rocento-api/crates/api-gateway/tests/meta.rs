use api_gateway::{identity, meta, public_commerce::policy::Deployment};
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use domain_admin_operations::meta::{Config, Consent, Input, Service};
use infra_auth::secrets::Vault;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture(pool: PgPool, permissions: Vec<&str>) -> (meta::App, Uuid) {
    let actor = Uuid::new_v4();
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Meta test',$2)")
        .bind(role)
        .bind(permissions)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'meta@example.test','Meta test','!',$2)").bind(actor).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("meta-session")).bind(actor).execute(&pool).await.unwrap();
    let security = infra_auth::Security::new(
        "meta-test-secret-".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let identity = identity::App::new(pool.clone(), security, vec!["http://localhost:5174".into()]);
    let mut a = meta::App::new(identity, Deployment::default()).unwrap();
    a.service = Service {
        pool,
        vault: Some(Vault::from_hex(&"ab".repeat(32)).unwrap()),
    };
    (a, actor)
}
fn input(revision: i64) -> Input {
    Input {
        expected_revision: revision,
        config: Config {
            api_version: "v23.0".into(),
            whatsapp_enabled: true,
            waba_id: "111".into(),
            phone_number_id: "222".into(),
            confirmation_template: "order_confirmation".into(),
            template_language: "en_US".into(),
            catalog_enabled: true,
            catalog_id: "333".into(),
            conversions_enabled: true,
            dataset_id: "444".into(),
            test_event_code: "TEST123".into(),
        },
        secrets: [
            ("whatsapp_token", "whatsapp-canary"),
            ("catalog_token", "catalog-canary"),
            ("conversions_token", "conversions-canary"),
            ("app_secret", "app-secret-canary"),
            ("webhook_verify_token", "verify-canary"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect(),
        clear_secrets: vec![],
    }
}
async fn request(
    app: Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: bool,
    csrf: bool,
) -> (u16, Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if cookie {
        r = r.header("cookie", "admin_session=meta-session");
    }
    if csrf {
        r = r.header("x-commerce-request", "1");
    }
    let response = app
        .oneshot(r.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let code = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (code, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}
#[sqlx::test(migrations = "../../migrations")]
async fn credentials_are_encrypted_revision_guarded_and_never_returned(pool: PgPool) {
    let (a, actor) = fixture(pool.clone(), vec!["*"]).await;
    let saved = a.service.save(actor, input(0)).await.unwrap();
    assert_eq!(saved.revision, 1);
    assert!(!serde_json::to_string(&saved).unwrap().contains("canary"));
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT credentials FROM platform.meta_settings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("canary"));
    let mut other = a.service.clone();
    other.vault = Some(Vault::from_hex(&"cd".repeat(32)).unwrap());
    assert!(other.credentials().await.is_err());
    assert!(matches!(
        a.service.save(actor, input(0)).await,
        Err(infra_auth::Error::Conflict)
    ));
    let mut update = input(1);
    update.secrets.clear();
    a.service.save(actor, update).await.unwrap();
    assert_eq!(
        a.service.credentials().await.unwrap()["whatsapp_token"],
        "whatsapp-canary"
    );
    let mut invalid = input(2);
    invalid.secrets.clear();
    invalid.clear_secrets.push("whatsapp_token".into());
    assert!(a.service.save(actor, invalid).await.is_err());
    let audit: String = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(to_jsonb(a))::text,'') FROM admin_iam.audit_log a",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!audit.contains("canary"));
    let original: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE platform.publication_installation SET installation_id=$1")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        a.service.credentials().await.is_err(),
        "copied ciphertext is bound to its installation"
    );
    sqlx::query("UPDATE platform.publication_installation SET installation_id=$1")
        .bind(original)
        .execute(&pool)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn permission_csrf_and_public_projection(pool: PgPool) {
    let (a, actor) = fixture(pool, vec!["integrations.meta.read"]).await;
    a.service.save(actor, input(0)).await.unwrap();
    let app = meta::router(a);
    assert_eq!(
        request(
            app.clone(),
            "GET",
            "/v1/admin/integrations/meta",
            json!({}),
            false,
            false
        )
        .await
        .0,
        401
    );
    let (code, status) = request(
        app.clone(),
        "GET",
        "/v1/admin/integrations/meta",
        json!({}),
        true,
        false,
    )
    .await;
    assert_eq!(code, 200);
    assert!(!status.to_string().contains("canary"));
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            "/v1/admin/integrations/meta",
            json!({}),
            true,
            false
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            app.clone(),
            "PUT",
            "/v1/admin/integrations/meta",
            json!({}),
            true,
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            app.clone(),
            "POST",
            "/v1/admin/integrations/meta/whatsapp/test",
            json!({}),
            true,
            true
        )
        .await
        .0,
        403
    );
    let (code, public) = request(
        app.clone(),
        "GET",
        "/v1/integrations/meta/status",
        json!({}),
        false,
        false,
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(public, json!({"whatsapp":true,"conversions":true}));
    assert_eq!(
        request(
            app.clone(),
            "GET",
            "/v1/integrations/meta/catalog.csv",
            json!({}),
            false,
            false
        )
        .await
        .0,
        404,
        "non-production feed is closed"
    );
    assert_eq!(
        request(
            app,
            "POST",
            "/v1/integrations/meta/webhook",
            json!({}),
            false,
            false
        )
        .await
        .0,
        403
    );
}
async fn order_fixture(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
    let customer = Uuid::new_v4();
    let quote = Uuid::new_v4();
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,'buyer@example.test','email','!',true)").bind(customer).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) VALUES($1,$2,gen_random_uuid(),gen_random_uuid(),'{}',now()+interval '1 hour')").bind(quote).bind(customer).execute(pool).await.unwrap();
    (customer, quote, order)
}
async fn place(pool: &PgPool, customer: Uuid, quote: Uuid, order: Uuid) {
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,gen_random_uuid(),'placed','{}','{\"email\":\"Buyer@Example.test\"}',10,0,10,'USD')").bind(order).bind(customer).bind(quote).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency) VALUES($1,'cod',10,'USD')").bind(order).execute(pool).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn consent_queues_only_owned_successful_orders_once_and_settings_cancel_jobs(pool: PgPool) {
    let (a, actor) = fixture(pool.clone(), vec!["*"]).await;
    a.service.save(actor, input(0)).await.unwrap();
    let (customer, quote, order) = order_fixture(&pool).await;
    let consent = Consent {
        conversions: true,
        whatsapp: true,
        phone: "+201012345678".into(),
    };
    assert!(a
        .service
        .record_consent(Uuid::new_v4(), quote, consent.clone())
        .await
        .is_err());
    a.service
        .record_consent(customer, quote, consent.clone())
        .await
        .unwrap();
    meta::prepare_orders(&a).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.meta_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    place(&pool, customer, quote, order).await;
    meta::prepare_orders(&a).await.unwrap();
    meta::prepare_orders(&a).await.unwrap();
    let jobs: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT kind,payload FROM platform.meta_jobs ORDER BY kind")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(jobs.len(), 2);
    let conversion: Value =
        serde_json::from_slice(&a.service.open(&jobs[0].1).await.unwrap()).unwrap();
    assert_eq!(
        conversion["data"][0]["event_id"],
        format!("purchase:{order}")
    );
    assert!(conversion["data"][0]["custom_data"]["value"].is_number());
    assert_eq!(
        conversion["data"][0]["event_source_url"],
        "http://localhost:5173/checkout"
    );
    assert_eq!(
        conversion["data"][0]["user_data"]["em"][0],
        infra_auth::digest("buyer@example.test")
    );
    assert!(!conversion.to_string().contains("Buyer@"));
    assert!(!String::from_utf8_lossy(&jobs[1].1).contains("201012345678"));
    a.service.save(actor, input(1)).await.unwrap();
    let states: Vec<String> = sqlx::query_scalar("SELECT status FROM platform.meta_jobs")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(states.iter().all(|s| s == "cancelled"));
    assert!(!meta::deliver_one(&a).await.unwrap());
    let mut disabled = input(2);
    disabled.config.whatsapp_enabled = false;
    disabled.config.conversions_enabled = false;
    a.service.save(actor, disabled).await.unwrap();
    // An uncertain checkout retry still resolves its committed order after an admin disables Meta.
    a.service
        .record_consent(customer, quote, consent)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn opt_out_cannot_be_replaced_by_a_checkout_replay(pool: PgPool) {
    let (a, actor) = fixture(pool.clone(), vec!["*"]).await;
    a.service.save(actor, input(0)).await.unwrap();
    let (customer, quote, order) = order_fixture(&pool).await;
    a.service
        .record_consent(customer, quote, Consent::default())
        .await
        .unwrap();
    place(&pool, customer, quote, order).await;
    a.service
        .record_consent(
            customer,
            quote,
            Consent {
                conversions: true,
                whatsapp: true,
                phone: "+201012345678".into(),
            },
        )
        .await
        .unwrap();
    meta::prepare_orders(&a).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.meta_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn signed_delivery_webhook_is_account_scoped_and_replay_safe(pool: PgPool) {
    let (a, actor) = fixture(pool.clone(), vec!["*"]).await;
    a.service.save(actor, input(0)).await.unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.meta_jobs(id,kind,dedupe_key,settings_revision,payload,status,provider_id,delivery_status) VALUES($1,'whatsapp','webhook-test',1,''::bytea,'accepted','wamid.test','sent')").bind(id).execute(&pool).await.unwrap();
    let app = meta::router(a);
    let body = r#"{"object":"whatsapp_business_account","entry":[{"id":"111","changes":[{"value":{"metadata":{"phone_number_id":"222"},"statuses":[{"id":"wamid.test","status":"delivered"}]}}]}]}"#;
    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/integrations/meta/webhook")
                    .header(
                        "x-hub-signature-256",
                        "sha256=8baa3434070f47ffaf8e5813e0e6c4a8b444348e2cd7c2fd2ce34455729a23c4",
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let status: String =
        sqlx::query_scalar("SELECT delivery_status FROM platform.meta_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "delivered");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.meta_delivery_receipts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let response = app
        .oneshot(
            Request::post("/v1/integrations/meta/webhook")
                .header(
                    "x-hub-signature-256",
                    "sha256=8baa3434070f47ffaf8e5813e0e6c4a8b444348e2cd7c2fd2ce34455729a23c4",
                )
                .body(Body::from(body.replace("111", "999")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}
