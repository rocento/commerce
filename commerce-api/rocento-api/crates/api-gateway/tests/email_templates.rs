use api_gateway::{email_templates, identity};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use infra_auth::{Notification, Security};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup(pool: &PgPool, permissions: Vec<&str>) -> (Router, Uuid, Uuid) {
    static SECURITY: tokio::sync::OnceCell<Security> = tokio::sync::OnceCell::const_new();
    let security = SECURITY
        .get_or_init(|| async {
            Security::new(
                "email-template-test-".repeat(3),
                "https://store.example.test".into(),
                false,
            )
            .await
            .unwrap()
        })
        .await
        .clone();
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Email editors',$2)")
        .bind(role)
        .bind(permissions)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'email-editor@example.test','Email editor','!',$2)").bind(user).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("email-editor-session")).bind(user).execute(pool).await.unwrap();
    (
        email_templates::router(identity::App::new(
            pool.clone(),
            security,
            vec!["https://admin.example.test".into()],
        )),
        role,
        user,
    )
}
async fn call(app: &Router, method: &str, suffix: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/v1/admin/email-templates{suffix}"))
                .header("cookie", "admin_session=email-editor-session")
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    (
        status,
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap(),
    )
}
fn notification(purpose: &str) -> Notification {
    Notification {
        identifier: "customer@example.test".into(),
        purpose: purpose.into(),
        code: "private-token".into(),
        mobile: false,
        link: if matches!(purpose, "verify" | "reset") {
            "https://store.example.test/verify?token=private-token".into()
        } else {
            "Order #42 confirmed. Total: 125.50 EGP.".into()
        },
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn draft_publish_history_restore_and_audit_are_transactional(pool: PgPool) {
    let (app, _, actor) = setup(&pool, vec!["*"]).await;
    sqlx::query(
        "UPDATE cms.discoverability_settings SET site_name='Example Market' WHERE singleton",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, collection) = call(&app, "GET", "", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(collection["items"].as_array().unwrap().len(), 4);
    assert_eq!(
        collection["items"][0]["variables"][0]["sample"],
        "Example Market"
    );
    let (_, original) = call(&app, "GET", "/order", Value::Null).await;
    assert_eq!(original["revision"], 0);
    assert_eq!(original["published"], Value::Null);
    assert_eq!(original["has_unpublished_changes"], false);
    let baseline = email_templates::render_notification(&pool, &notification("order"))
        .await
        .unwrap();
    assert_eq!(baseline.subject, "Your Example Market order confirmation");
    let mut content = original["draft"].clone();
    content["subject"] = json!("Confirmed by {{brand_name}}");
    content["heading"] = json!("<script>alert('test')</script>");
    let (status, saved) = call(
        &app,
        "PUT",
        "/order",
        json!({"expected_revision":0,"content":content,"change_note":"Improve confirmation copy"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["has_unpublished_changes"], true);
    assert_eq!(
        email_templates::render_notification(&pool, &notification("order"))
            .await
            .unwrap()
            .subject,
        baseline.subject
    );
    let (status, preview) = call(&app, "POST", "/order/preview", json!({"content":content})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["subject"], "Confirmed by Example Market");
    assert!(preview["html"].as_str().unwrap().contains("&lt;script&gt;"));
    assert!(!preview["html"].as_str().unwrap().contains("<script>"));
    assert!(preview["text"].as_str().unwrap().contains("#1042"));
    let (status, conflict) = call(
        &app,
        "POST",
        "/order/publish",
        json!({"expected_revision":0,"change_note":"Publish reviewed copy"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "stale_revision");
    let (status, published) = call(
        &app,
        "POST",
        "/order/publish",
        json!({"expected_revision":1,"change_note":"Publish reviewed copy"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(published["published_version"], 1);
    assert_eq!(published["revision"], 2);
    assert_eq!(published["has_unpublished_changes"], false);
    assert_eq!(
        email_templates::render_notification(&pool, &notification("order"))
            .await
            .unwrap()
            .subject,
        "Confirmed by Example Market"
    );
    content["subject"] = json!("A second confirmation");
    assert_eq!(
        call(
            &app,
            "PUT",
            "/order",
            json!({"expected_revision":2,"content":content,"change_note":"Prepare second release"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/order/publish",
            json!({"expected_revision":3,"change_note":"Publish second release"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, restored) = call(
        &app,
        "POST",
        "/order/restore",
        json!({"expected_revision":4,"version":1,"change_note":"Restore original wording"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["draft"]["subject"], "Confirmed by {{brand_name}}");
    assert_eq!(restored["published"]["subject"], "A second confirmation");
    assert_eq!(restored["has_unpublished_changes"], true);
    assert_eq!(restored["revision"], 5);
    assert_eq!(
        email_templates::render_notification(&pool, &notification("order"))
            .await
            .unwrap()
            .subject,
        "A second confirmation"
    );
    let (_, history) = call(&app, "GET", "/order/history", Value::Null).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 2);
    assert_eq!(history["items"][0]["version"], 2);
    assert_eq!(history["items"][1]["published_by"], actor.to_string());
    assert_eq!(history["next_before_version"], Value::Null);
    assert!(sqlx::query("UPDATE platform.email_template_versions SET change_note='tampered' WHERE template_key='order' AND version=1").execute(&pool).await.is_err());
    assert!(sqlx::query(
        "DELETE FROM platform.email_template_versions WHERE template_key='order' AND version=1"
    )
    .execute(&pool)
    .await
    .is_err());
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT details FROM admin_iam.audit_log WHERE action LIKE 'email_templates.%'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(audits.len(), 5);
    assert!(audits.iter().all(|a| a.get("change_note").is_some()));
    assert!(audits
        .iter()
        .all(|a| !a.to_string().contains("private-token") && a.get("content").is_none()));
}

#[sqlx::test(migrations = "../../migrations")]
async fn permissions_csrf_validation_and_stale_writers_are_enforced(pool: PgPool) {
    let (app, role, _) = setup(&pool, vec!["email_templates.read"]).await;
    let anonymous = app
        .clone()
        .oneshot(
            Request::get("/v1/admin/email-templates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let (_, template) = call(&app, "GET", "/verify", Value::Null).await;
    let content = template["draft"].clone();
    assert_eq!(
        call(&app, "POST", "/verify/preview", json!({"content":content}))
            .await
            .0,
        StatusCode::OK
    );
    let mutation =
        json!({"expected_revision":0,"content":content,"change_note":"Reviewed copy change"});
    assert_eq!(
        call(&app, "PUT", "/verify", mutation.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/verify/publish",
            json!({"expected_revision":0,"change_note":"Reviewed copy change"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['email_templates.read','email_templates.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    for (csrf, origin) in [
        (false, "https://admin.example.test"),
        (true, "https://attacker.example"),
    ] {
        let mut request = Request::put("/v1/admin/email-templates/verify")
            .header("cookie", "admin_session=email-editor-session")
            .header("content-type", "application/json")
            .header("origin", origin);
        if csrf {
            request = request.header("x-commerce-request", "1");
        }
        assert_eq!(
            app.clone()
                .oneshot(request.body(Body::from(mutation.to_string())).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut invalid = mutation.clone();
    invalid["content"]["subject"] = json!("Injected\r\nBcc: attacker@example.test");
    assert_eq!(
        call(&app, "PUT", "/verify", invalid).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = mutation.clone();
    invalid["content"]["body"] = json!("Missing expiry");
    assert_eq!(
        call(&app, "PUT", "/verify", invalid).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = mutation.clone();
    invalid["content"]["html"] = json!("<script/>");
    assert_eq!(
        call(&app, "PUT", "/verify", invalid).await.0,
        StatusCode::BAD_REQUEST
    );
    let (a, b) = tokio::join!(
        call(&app, "PUT", "/verify", mutation.clone()),
        call(&app, "PUT", "/verify", mutation)
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    assert_eq!(
        call(&app, "GET", "/verify", Value::Null).await.1["revision"],
        1
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/verify/publish",
            json!({"expected_revision":1,"change_note":"Writers cannot publish"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['reports.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    for suffix in ["", "/verify", "/verify/history"] {
        assert_eq!(
            call(&app, "GET", suffix, Value::Null).await.0,
            StatusCode::FORBIDDEN
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn history_paginates_and_account_security_copy_survives_customization(pool: PgPool) {
    let (app, _, actor) = setup(&pool, vec!["*"]).await;
    let (_, template) = call(&app, "GET", "/reset", Value::Null).await;
    let mut content = template["draft"].clone();
    content["body"] = json!("Your requested link expires in {{expires_minutes}} minutes.");
    for version in 1_i64..=51 {
        sqlx::query("INSERT INTO platform.email_template_versions(template_key,version,content,change_note,published_by) VALUES('reset',$1,$2,'Reviewed copy',$3)").bind(version).bind(&content).bind(actor).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE platform.email_templates SET published_version=51 WHERE key='reset'")
        .execute(&pool)
        .await
        .unwrap();
    let (_, first) = call(&app, "GET", "/reset/history", Value::Null).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(first["next_before_version"], 2);
    let (_, second) = call(&app, "GET", "/reset/history?before_version=2", Value::Null).await;
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["version"], 1);
    assert_eq!(second["next_before_version"], Value::Null);
    let rendered = email_templates::render_notification(&pool, &notification("reset"))
        .await
        .unwrap();
    assert!(rendered.text.contains("only be used once"));
    assert!(rendered.html.contains("If you did not request this email"));
    assert!(rendered
        .text
        .contains("https://store.example.test/verify?token=private-token"));
}
