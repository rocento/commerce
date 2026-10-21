use api_gateway::notifications::{deliver_one, enqueue_commerce, Delivery, Mailpit, Transport};
use infra_auth::{Notification, Security};
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use uuid::Uuid;

#[derive(Default)]
struct Inbox {
    messages: Mutex<Vec<Notification>>,
    attempted_ids: Mutex<Vec<Uuid>>,
    failures: AtomicUsize,
}
impl Transport for Inbox {
    fn send<'a>(&'a self, id: Uuid, notification: &'a Notification) -> Delivery<'a> {
        Box::pin(async move {
            self.attempted_ids.lock().unwrap().push(id);
            if self
                .failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err("provider_unavailable");
            }
            self.messages.lock().unwrap().push(notification.clone());
            Ok(())
        })
    }
}
async fn customers(pool: &PgPool) -> domain_customers::Service {
    let mut security = Security::new(
        "notification-test-secret-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    security.queued_notifications = true;
    domain_customers::Service {
        pool: pool.clone(),
        security,
    }
}
async fn register(service: &domain_customers::Service) -> Uuid {
    service
        .register(domain_customers::Credentials {
            identifier: "inbox@example.test".into(),
            password: "Test notification password!".into(),
        })
        .await
        .unwrap()
        .id
}

#[sqlx::test(migrations = "../../migrations")]
async fn durable_challenges_retry_expire_and_remain_single_use(pool: PgPool) {
    let service = customers(&pool).await;
    let customer = register(&service).await;
    let inbox = Inbox::default();
    inbox.failures.store(1, Ordering::SeqCst);
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(inbox.messages.lock().unwrap().is_empty());
    assert!(
        !deliver_one(&pool, &inbox).await.unwrap(),
        "retry uses backoff"
    );
    sqlx::query("UPDATE platform.notification_jobs SET available_at=clock_timestamp() WHERE status='pending'").execute(&pool).await.unwrap();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(
        !deliver_one(&pool, &inbox).await.unwrap(),
        "completed jobs are not repeated"
    );
    let n = inbox.messages.lock().unwrap()[0].clone();
    service
        .verify(domain_customers::Verify {
            identifier: n.identifier.clone(),
            token: n.code.clone(),
        })
        .await
        .unwrap();
    assert!(service
        .verify(domain_customers::Verify {
            identifier: n.identifier,
            token: n.code
        })
        .await
        .is_err());
    let cleared: bool = sqlx::query_scalar("SELECT payload IS NULL AND attempts=2 FROM platform.notification_jobs WHERE customer_id=$1")
        .bind(customer).fetch_one(&pool).await.unwrap();
    assert!(cleared);
    for _ in 0..2 {
        service
            .request_challenge(
                domain_customers::ChallengeRequest {
                    identifier: "inbox@example.test".into(),
                },
                "reset",
            )
            .await
            .unwrap();
    }
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert_eq!(
        inbox.messages.lock().unwrap().len(),
        2,
        "only the latest reset is sent"
    );
    service
        .request_challenge(
            domain_customers::ChallengeRequest {
                identifier: "inbox@example.test".into(),
            },
            "reset",
        )
        .await
        .unwrap();
    sqlx::query("UPDATE customers.challenges SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !deliver_one(&pool, &inbox).await.unwrap(),
        "expired token is not sent"
    );
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.notification_jobs WHERE payload IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn queue_failure_rolls_back_registration_and_workers_do_not_duplicate(pool: PgPool) {
    let service = customers(&pool).await;
    sqlx::query(
        "ALTER TABLE platform.notification_jobs ADD CONSTRAINT reject_enqueue CHECK (false)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(service
        .register(domain_customers::Credentials {
            identifier: "rollback@example.test".into(),
            password: "Test notification password!".into()
        })
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.customers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("ALTER TABLE platform.notification_jobs DROP CONSTRAINT reject_enqueue")
        .execute(&pool)
        .await
        .unwrap();
    register(&service).await;
    let inbox = Inbox::default();
    let (one, two) = tokio::join!(deliver_one(&pool, &inbox), deliver_one(&pool, &inbox));
    assert_ne!(one.unwrap(), two.unwrap());
    assert_eq!(inbox.messages.lock().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn exhausted_retries_scrub_sensitive_payload(pool: PgPool) {
    register(&customers(&pool).await).await;
    let inbox = Inbox::default();
    inbox.failures.store(10, Ordering::SeqCst);
    for _ in 0..5 {
        sqlx::query("UPDATE platform.notification_jobs SET available_at=clock_timestamp()")
            .execute(&pool)
            .await
            .unwrap();
        assert!(deliver_one(&pool, &inbox).await.unwrap());
    }
    let terminal:bool=sqlx::query_scalar("SELECT status='failed' AND payload IS NULL AND attempts=5 AND last_error='provider_unavailable' FROM platform.notification_jobs").fetch_one(&pool).await.unwrap();
    assert!(terminal);
    assert!(!deliver_one(&pool, &inbox).await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn smtp_commerce_jobs_commit_with_receipts_and_retry_with_stable_ids(pool: PgPool) {
    let customer = register(&customers(&pool).await).await;
    sqlx::query("DELETE FROM platform.notification_jobs")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM customers.challenges")
        .execute(&pool)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for purpose in ["order", "shipment"] {
        let id = Uuid::new_v4();
        ids.push(id);
        let notification = Notification {
            identifier: "inbox@example.test".into(),
            purpose: purpose.into(),
            code: String::new(),
            link: format!("Order #42 {purpose} update"),
            mobile: false,
        };
        let mut rolled_back = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO platform.consumer_receipts(consumer_name,event_id) VALUES('smtp-routing-test',$1)")
            .bind(id).execute(&mut *rolled_back).await.unwrap();
        assert!(
            enqueue_commerce(&mut rolled_back, "smtp", id, customer, &notification)
                .await
                .unwrap()
        );
        rolled_back.rollback().await.unwrap();
        let absent: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM platform.consumer_receipts WHERE event_id=$1) AND NOT EXISTS(SELECT 1 FROM platform.notification_jobs WHERE id=$1)")
            .bind(id).fetch_one(&pool).await.unwrap();
        assert!(absent, "receipt and email job roll back together");

        let mut receipt = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO platform.consumer_receipts(consumer_name,event_id) VALUES('smtp-routing-test',$1)")
            .bind(id).execute(&mut *receipt).await.unwrap();
        for _ in 0..2 {
            assert!(
                enqueue_commerce(&mut receipt, "smtp", id, customer, &notification)
                    .await
                    .unwrap()
            );
        }
        receipt.commit().await.unwrap();
        let queued: (String, bool, serde_json::Value) = sqlx::query_as("SELECT purpose, challenge_hash IS NULL AND expires_at > clock_timestamp()+interval '23 hours', payload FROM platform.notification_jobs WHERE id=$1")
            .bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(queued.0, purpose);
        assert!(
            queued.1,
            "commerce jobs do not depend on verification challenges"
        );
        assert_eq!(queued.2, serde_json::to_value(&notification).unwrap());

        let mut local = pool.begin().await.unwrap();
        assert!(!enqueue_commerce(
            &mut local,
            "console",
            Uuid::new_v4(),
            customer,
            &notification
        )
        .await
        .unwrap());
        assert!(enqueue_commerce(
            &mut local,
            "mailpit",
            Uuid::new_v4(),
            customer,
            &notification
        )
        .await
        .unwrap());
        local.rollback().await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2, "event redelivery cannot create another job");
    let inbox = Inbox::default();
    inbox.failures.store(1, Ordering::SeqCst);
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(
        !deliver_one(&pool, &inbox).await.unwrap(),
        "retry respects backoff"
    );
    sqlx::query("UPDATE platform.notification_jobs SET available_at=clock_timestamp() WHERE status='pending'")
        .execute(&pool).await.unwrap();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(!deliver_one(&pool, &inbox).await.unwrap());
    let attempted = inbox.attempted_ids.lock().unwrap().clone();
    assert_eq!(attempted.len(), 3);
    assert_eq!(
        attempted[0], attempted[2],
        "retry preserves the Message-ID input"
    );
    assert!(attempted.iter().all(|id| ids.contains(id)));
    assert_eq!(inbox.messages.lock().unwrap().len(), 2);
    let cleared: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs WHERE status='delivered' AND payload IS NULL")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cleared, 2);
}

#[test]
fn mailpit_rejects_remote_or_credential_bearing_urls() {
    for url in [
        "https://example.com",
        "http://example.com",
        "http://user:password@localhost",
        "http://localhost/redirect",
        "http://localhost?token=private",
    ] {
        assert!(Mailpit::new(url, "store@example.test").is_err());
    }
    assert!(Mailpit::new("http://localhost:8025", "invalid").is_err());
}

#[tokio::test]
#[ignore = "requires isolated local Mailpit; set MAILPIT_TEST_URL"]
async fn live_mailpit_captures_verification_email() {
    let base = std::env::var("MAILPIT_TEST_URL").expect("set isolated inbox URL");
    let transport = Mailpit::new(&base, "store@example.test").unwrap();
    let id = Uuid::new_v4();
    let n = Notification {
        identifier: format!("{id}@example.test"),
        purpose: "verify".into(),
        code: "synthetic-code".into(),
        link: "http://localhost:5173/verify?token=synthetic-code".into(),
        mobile: false,
    };
    transport.send(id, &n).await.unwrap();
    let response: serde_json::Value =
        reqwest::get(format!("{base}/api/v1/search?query=to:{}", n.identifier))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert_eq!(response["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        response["messages"][0]["Subject"],
        "Verify your Rocento account"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn malformed_pinned_rendering_fails_without_contacting_delivery(pool: PgPool) {
    register(&customers(&pool).await).await;
    sqlx::query("UPDATE platform.notification_jobs SET payload=jsonb_set(payload, '{rendered_email}', '{\"subject\":123}'::jsonb)")
        .execute(&pool).await.unwrap();
    let inbox = Inbox::default();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(inbox.attempted_ids.lock().unwrap().is_empty());
    let terminal: bool = sqlx::query_scalar(
        "SELECT status='failed' AND payload IS NULL AND attempts=1 AND last_error='invalid_payload' FROM platform.notification_jobs",
    ).fetch_one(&pool).await.unwrap();
    assert!(terminal);
}

#[derive(Default)]
struct CapturedMail {
    messages: Mutex<Vec<serde_json::Value>>,
    failures: AtomicUsize,
}

async fn capture_mail(
    axum::extract::State(inbox): axum::extract::State<Arc<CapturedMail>>,
    axum::Json(message): axum::Json<serde_json::Value>,
) -> axum::http::StatusCode {
    inbox.messages.lock().unwrap().push(message);
    if inbox
        .failures
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
    {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    } else {
        axum::http::StatusCode::OK
    }
}

async fn captured_mailpit() -> (Mailpit, Arc<CapturedMail>, tokio::task::JoinHandle<()>) {
    let inbox = Arc::new(CapturedMail::default());
    let router = axum::Router::new()
        .route("/api/v1/send", axum::routing::post(capture_mail))
        .with_state(inbox.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let transport = Mailpit::new(&format!("http://{address}"), "store@example.test").unwrap();
    (transport, inbox, task)
}

#[sqlx::test(migrations = "../../migrations")]
async fn built_in_mailpit_delivery_has_safe_html_text_and_scrubs_payload(pool: PgPool) {
    sqlx::query(
        "UPDATE cms.discoverability_settings SET site_name='Test Store & Sons' WHERE singleton",
    )
    .execute(&pool)
    .await
    .unwrap();
    register(&customers(&pool).await).await;
    let (transport, inbox, task) = captured_mailpit().await;
    assert!(deliver_one(&pool, &transport).await.unwrap());
    let messages = inbox.messages.lock().unwrap().clone();
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message["Subject"], "Verify your Test Store & Sons account");
    assert!(message["HTML"]
        .as_str()
        .unwrap()
        .contains("Test Store &amp; Sons"));
    assert!(message["Text"]
        .as_str()
        .unwrap()
        .contains("http://localhost:5173/verify"));
    assert!(message["HTML"]
        .as_str()
        .unwrap()
        .contains("http://localhost:5173/verify"));
    assert!(message["Text"].as_str().unwrap().contains("15 minutes"));
    assert!(message["HTML"].as_str().unwrap().contains("15 minutes"));
    let cleared: bool = sqlx::query_scalar(
        "SELECT status='delivered' AND payload IS NULL FROM platform.notification_jobs",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(cleared);
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn mailpit_escapes_commerce_values_in_html_without_changing_plain_text(pool: PgPool) {
    let customer = register(&customers(&pool).await).await;
    sqlx::query("DELETE FROM platform.notification_jobs")
        .execute(&pool)
        .await
        .unwrap();
    let n = Notification {
        identifier: "inbox@example.test".into(),
        purpose: "order".into(),
        code: String::new(),
        link: "Order <script>alert('unsafe')</script> & fragile".into(),
        mobile: false,
    };
    let mut tx = pool.begin().await.unwrap();
    enqueue_commerce(&mut tx, "mailpit", Uuid::new_v4(), customer, &n)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (transport, inbox, task) = captured_mailpit().await;
    assert!(deliver_one(&pool, &transport).await.unwrap());
    let messages = inbox.messages.lock().unwrap().clone();
    let message = &messages[0];
    assert!(message["Text"].as_str().unwrap().contains(&n.link));
    let html = message["HTML"].as_str().unwrap();
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("&amp; fragile"));
    assert!(!html.contains("<script>"));
    task.abort();
}

async fn publish_order_template(pool: &PgPool, version: i64) {
    let content = serde_json::json!({
        "subject": format!("Published order v{version}"),
        "heading": "Order update",
        "body": format!("Published version {version}: {{{{message}}}}"),
        "cta_label": null,
    });
    let draft = serde_json::json!({
        "subject": "Unpublished draft subject", "heading": "Draft heading",
        "body": "Draft copy: {{message}}", "cta_label": null,
    });
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO platform.email_template_versions(template_key,version,content,change_note,published_by) VALUES('order',$1,$2,'Delivery integration test',$3)")
        .bind(version).bind(content).bind(Uuid::new_v4()).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE platform.email_templates SET published_version=$1,draft_content=$2 WHERE key='order'")
        .bind(version).bind(draft).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn published_delivery_ignores_drafts_and_pins_content_across_retries(pool: PgPool) {
    let customer = register(&customers(&pool).await).await;
    sqlx::query("DELETE FROM platform.notification_jobs")
        .execute(&pool)
        .await
        .unwrap();
    publish_order_template(&pool, 1).await;
    let n = Notification {
        identifier: "inbox@example.test".into(),
        purpose: "order".into(),
        code: String::new(),
        link: "Order <script>alert('unsafe')</script> & fragile".into(),
        mobile: false,
    };
    let first_id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    enqueue_commerce(&mut tx, "mailpit", first_id, customer, &n)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (transport, inbox, task) = captured_mailpit().await;
    inbox.failures.store(1, Ordering::SeqCst);
    assert!(deliver_one(&pool, &transport).await.unwrap());
    let pinned: serde_json::Value = sqlx::query_scalar(
        "SELECT payload->'rendered_email' FROM platform.notification_jobs WHERE id=$1",
    )
    .bind(first_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pinned["subject"], "Published order v1");
    assert!(pinned["html"].as_str().unwrap().contains("&lt;script&gt;"));
    assert!(!pinned["html"].as_str().unwrap().contains("<script>"));
    assert!(!pinned["text"].as_str().unwrap().contains("Draft copy"));
    publish_order_template(&pool, 2).await;
    sqlx::query("UPDATE platform.notification_jobs SET available_at=clock_timestamp() WHERE id=$1")
        .bind(first_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(deliver_one(&pool, &transport).await.unwrap());
    let second_id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    enqueue_commerce(&mut tx, "mailpit", second_id, customer, &n)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(deliver_one(&pool, &transport).await.unwrap());
    let messages = inbox.messages.lock().unwrap().clone();
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[0], messages[1],
        "retry must preserve the entire provider payload and Message-ID"
    );
    assert_eq!(messages[0]["Subject"], "Published order v1");
    assert_eq!(messages[0]["Text"], pinned["text"]);
    assert_eq!(messages[0]["HTML"], pinned["html"]);
    assert!(messages[0]["Text"].as_str().unwrap().contains(&n.link));
    assert_eq!(messages[2]["Subject"], "Published order v2");
    assert!(messages[2]["Text"]
        .as_str()
        .unwrap()
        .contains("Published version 2:"));
    let cleared: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs WHERE status='delivered' AND payload IS NULL")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cleared, 2);
    task.abort();
}
