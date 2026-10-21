use api_gateway::{
    auth_ip::AuthIpRateLimit,
    email_templates::RenderedEmail,
    identity,
    notifications::{deliver_one, Delivery, Transport},
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use infra_auth::{Notification, Security};
use serde_json::json;
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tower::ServiceExt;
use uuid::Uuid;
async fn login(app: &Router, admin: bool, email: &str, password: &str) -> StatusCode {
    let body = if admin {
        json!({"email":email,"password":password})
    } else {
        json!({"identifier":email,"password":password})
    };
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(if admin {
                    "/v1/admin/auth/login"
                } else {
                    "/v1/customer/auth/login"
                })
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("x-forwarded-for", "198.51.100.42")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
#[derive(Default)]
struct Inbox {
    failed: AtomicBool,
    attempts: Mutex<Vec<(Uuid, String)>>,
}
impl Transport for Inbox {
    fn send<'a>(&'a self, _: Uuid, _: &'a Notification) -> Delivery<'a> {
        Box::pin(async { panic!("Rendering required") })
    }
    fn send_rendered<'a>(
        &'a self,
        id: Uuid,
        n: &'a Notification,
        email: &'a RenderedEmail,
    ) -> Delivery<'a> {
        Box::pin(async move {
            assert_eq!(n.identifier, "info@rocento.com");
            assert!(n.code.is_empty());
            assert!(email.text.contains("198.51.100.42"));
            assert!(email.text.contains("Approximate location: Unavailable"));
            self.attempts.lock().unwrap().push((id, email.text.clone()));
            if !self.failed.swap(true, Ordering::SeqCst) {
                Err("provider_unavailable")
            } else {
                Ok(())
            }
        })
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn only_successful_exact_account_logins_queue_retryable_alerts(pool: PgPool) {
    let security = Security::new(
        "login-alert-tests-secret".repeat(3),
        "https://grocery.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let admins = domain_admin_iam::Service {
        pool: pool.clone(),
        security: security.clone(),
    };
    admins
        .seed("demo@rocento.com", "CorrectPassword123!".into())
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) SELECT gen_random_uuid(),'other@example.test','Other',password_hash,role_id FROM admin_iam.admin_users WHERE email='demo@rocento.com'").execute(&pool).await.unwrap();
    let customers = domain_customers::Service {
        pool: pool.clone(),
        security: security.clone(),
    };
    customers
        .register(domain_customers::Credentials {
            identifier: "demo@rocento.com".into(),
            password: "CorrectPassword123!".into(),
        })
        .await
        .unwrap();
    let mut state = identity::App::new(pool.clone(), security, vec![]);
    state.auth_ip_rate_limit = AuthIpRateLimit::Ingress;
    let app = identity::router(state);
    assert_eq!(
        login(&app, true, "demo@rocento.com", "WrongPassword!").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, true, "other@example.test", "CorrectPassword123!").await,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.notification_jobs WHERE purpose='demo_login'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    for _ in 0..2 {
        assert_eq!(
            login(&app, true, "DEMO@ROCENTO.COM", "CorrectPassword123!").await,
            StatusCode::OK
        );
    }
    assert_eq!(
        login(&app, false, "demo@rocento.com", "CorrectPassword123!").await,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.notification_jobs WHERE purpose='demo_login'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    let inbox = Inbox::default();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    sqlx::query("UPDATE platform.notification_jobs SET available_at=now()-interval '1 second' WHERE attempts=1").execute(&pool).await.unwrap();
    while deliver_one(&pool, &inbox).await.unwrap() {}
    let attempts = inbox.attempts.lock().unwrap().clone();
    assert_eq!(attempts.len(), 4);
    let first = &attempts[0];
    assert_eq!(attempts.iter().filter(|a| a.0 == first.0).count(), 2);
    assert!(attempts
        .iter()
        .filter(|a| a.0 == first.0)
        .all(|a| a.1 == first.1));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM platform.notification_jobs WHERE purpose='demo_login' AND status='delivered' AND payload IS NULL").fetch_one(&pool).await.unwrap(),3);
}
