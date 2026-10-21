use api_gateway::{
    analytics::Client,
    commerce_notifications::Consumer,
    notifications::{deliver_one, enqueue_commerce, Delivery, Transport},
};
use axum::{http::StatusCode, routing::post, Router};
use infra_auth::Notification;
use infra_events::EventEnvelope;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use uuid::Uuid;

const LEGACY: &str = "order-facts-v1";
const ANALYTICS: &str = "order-analytics-v2";
const CONFIRMATIONS: &str = "order-notifications-v1";

async fn order_event(pool: &PgPool) -> EventEnvelope {
    let customer = Uuid::new_v4();
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,'confirmation@example.test','email','unused')")
        .bind(customer).execute(pool).await.unwrap();
    let number: i64 = sqlx::query_scalar("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}',$5,12,0,12,'USD') RETURNING number")
        .bind(order).bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4())
        .bind(json!({"primary_identifier":"email","email":"confirmation@example.test"}))
        .fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency) VALUES($1,'cod',12,'USD')")
        .bind(order).execute(pool).await.unwrap();
    EventEnvelope {
        id: Uuid::new_v4().to_string(),
        event_type: "order.placed".into(),
        schema_version: 1,
        payload: json!({"order_id":order,"customer_id":customer,"number":number,"total":"12.00","currency":"USD","item_count":1}),
    }
}

fn event_id(event: &EventEnvelope) -> Uuid {
    event.id.parse().unwrap()
}

async fn receipt(pool: &PgPool, consumer: &str, event: &EventEnvelope) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.consumer_receipts WHERE consumer_name=$1 AND event_id=$2)")
        .bind(consumer).bind(event_id(event)).fetch_one(pool).await.unwrap()
}

async fn jobs(pool: &PgPool, event: &EventEnvelope) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs WHERE id=$1")
        .bind(event_id(event))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[derive(Default)]
struct Inbox(Mutex<Vec<(Uuid, Notification)>>);

impl Transport for Inbox {
    fn send<'a>(&'a self, id: Uuid, notification: &'a Notification) -> Delivery<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push((id, notification.clone()));
            Ok(())
        })
    }
}

struct ClickHouse {
    client: Client,
    available: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    rows: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl ClickHouse {
    async fn start(available: bool) -> Self {
        let available = Arc::new(AtomicBool::new(available));
        let requests = Arc::new(AtomicUsize::new(0));
        let rows = Arc::new(Mutex::new(Vec::new()));
        let route = {
            let available = available.clone();
            let requests = requests.clone();
            let rows = rows.clone();
            post(move |body: String| {
                let available = available.clone();
                let requests = requests.clone();
                let rows = rows.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    if !available.load(Ordering::SeqCst) {
                        return StatusCode::SERVICE_UNAVAILABLE;
                    }
                    rows.lock()
                        .unwrap()
                        .push(serde_json::from_str(&body).unwrap());
                    StatusCode::OK
                }
            })
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", route))
                .await
                .unwrap();
        });
        Self {
            client: Client::new(format!("http://{address}"), "test".into(), "test".into()),
            available,
            requests,
            rows,
            server,
        }
    }
}

impl Drop for ClickHouse {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn confirmation_is_delivered_while_analytics_fails_and_facts_recover(pool: PgPool) {
    let event = order_event(&pool).await;
    let clickhouse = ClickHouse::start(false).await;
    assert!(clickhouse.client.record_order(&pool, &event).await.is_err());
    assert!(!receipt(&pool, ANALYTICS, &event).await);

    Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .unwrap();
    let inbox = Inbox::default();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert_eq!(inbox.0.lock().unwrap().len(), 1);
    let (id, message) = inbox.0.lock().unwrap()[0].clone();
    assert_eq!(id, event_id(&event));
    assert_eq!(message.purpose, "order");
    assert_eq!(message.identifier, "confirmation@example.test");
    assert!(message.link.contains("confirmed"));
    assert!(receipt(&pool, CONFIRMATIONS, &event).await);
    assert!(!receipt(&pool, LEGACY, &event).await);
    assert!(clickhouse.rows.lock().unwrap().is_empty());
    assert_eq!(clickhouse.requests.load(Ordering::SeqCst), 1);

    clickhouse.available.store(true, Ordering::SeqCst);
    let (first, second) = tokio::join!(
        clickhouse.client.record_order(&pool, &event),
        clickhouse.client.record_order(&pool, &event)
    );
    first.unwrap();
    second.unwrap();
    assert!(receipt(&pool, ANALYTICS, &event).await);
    assert!(!receipt(&pool, LEGACY, &event).await);
    assert_eq!(clickhouse.rows.lock().unwrap().len(), 1);
    assert_eq!(clickhouse.rows.lock().unwrap()[0]["id"], event.id);
    assert_eq!(jobs(&pool, &event).await, 1);
    assert!(!deliver_one(&pool, &inbox).await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn confirmation_replays_and_concurrent_workers_enqueue_once(pool: PgPool) {
    let event = order_event(&pool).await;
    let (first, second) = tokio::join!(
        Consumer::Orders.process(&pool, "smtp", &event),
        Consumer::Orders.process(&pool, "smtp", &event)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(jobs(&pool, &event).await, 1);
    let inbox = Inbox::default();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    let scrubbed: bool = sqlx::query_scalar(
        "SELECT status='delivered' AND payload IS NULL FROM platform.notification_jobs WHERE id=$1",
    )
    .bind(event_id(&event))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(scrubbed);

    Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .unwrap();
    assert_eq!(jobs(&pool, &event).await, 1);
    assert!(!deliver_one(&pool, &inbox).await.unwrap());
    assert_eq!(inbox.0.lock().unwrap().len(), 1);
    assert!(receipt(&pool, CONFIRMATIONS, &event).await);
    assert!(!receipt(&pool, ANALYTICS, &event).await);
    assert!(!receipt(&pool, LEGACY, &event).await);
}

#[sqlx::test(migrations = "../../migrations")]
async fn queue_failure_rolls_back_confirmation_receipt_and_can_retry(pool: PgPool) {
    let event = order_event(&pool).await;
    sqlx::query("ALTER TABLE platform.notification_jobs ADD CONSTRAINT reject_order_job CHECK (purpose <> 'order')")
        .execute(&pool).await.unwrap();
    assert!(Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .is_err());
    assert!(!receipt(&pool, CONFIRMATIONS, &event).await);
    assert_eq!(jobs(&pool, &event).await, 0);

    sqlx::query("ALTER TABLE platform.notification_jobs DROP CONSTRAINT reject_order_job")
        .execute(&pool)
        .await
        .unwrap();
    Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .unwrap();
    assert!(receipt(&pool, CONFIRMATIONS, &event).await);
    assert_eq!(jobs(&pool, &event).await, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn historical_combined_receipt_suppresses_replay_without_a_retained_job(pool: PgPool) {
    let event = order_event(&pool).await;
    sqlx::query("INSERT INTO platform.consumer_receipts(consumer_name,event_id) VALUES($1,$2)")
        .bind(LEGACY)
        .bind(event_id(&event))
        .execute(&pool)
        .await
        .unwrap();
    // Legacy console delivery also has a receipt, but no notification_jobs row.
    let clickhouse = ClickHouse::start(false).await;
    Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .unwrap();
    clickhouse.client.record_order(&pool, &event).await.unwrap();
    assert_eq!(jobs(&pool, &event).await, 0);
    assert!(receipt(&pool, LEGACY, &event).await);
    assert!(receipt(&pool, CONFIRMATIONS, &event).await);
    assert!(receipt(&pool, ANALYTICS, &event).await);
    assert_eq!(clickhouse.requests.load(Ordering::SeqCst), 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn uncommitted_legacy_receipt_cannot_hold_up_new_confirmations(pool: PgPool) {
    let event = order_event(&pool).await;
    let mut legacy = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO platform.consumer_receipts(consumer_name,event_id) VALUES($1,$2)")
        .bind(LEGACY)
        .bind(event_id(&event))
        .execute(&mut *legacy)
        .await
        .unwrap();
    // The old worker is now waiting on ClickHouse with its receipt uncommitted.
    tokio::time::timeout(
        Duration::from_secs(2),
        Consumer::Orders.process(&pool, "smtp", &event),
    )
    .await
    .expect("confirmation must not wait for the old analytics transaction")
    .unwrap();
    assert_eq!(jobs(&pool, &event).await, 1);
    let queued: Value =
        sqlx::query_scalar("SELECT payload FROM platform.notification_jobs WHERE id=$1")
            .bind(event_id(&event))
            .fetch_one(&pool)
            .await
            .unwrap();

    // Once old analytics recovers, its enqueue uses the same event ID and cannot
    // replace or duplicate the job that the new worker already committed.
    let notification = Notification {
        identifier: "confirmation@example.test".into(),
        purpose: "order".into(),
        code: String::new(),
        link: "Legacy worker confirmation".into(),
        mobile: false,
    };
    enqueue_commerce(
        &mut legacy,
        "smtp",
        event_id(&event),
        serde_json::from_value(event.payload["customer_id"].clone()).unwrap(),
        &notification,
    )
    .await
    .unwrap();
    legacy.commit().await.unwrap();
    let preserved: Value =
        sqlx::query_scalar("SELECT payload FROM platform.notification_jobs WHERE id=$1")
            .bind(event_id(&event))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(preserved, queued);
    let inbox = Inbox::default();
    assert!(deliver_one(&pool, &inbox).await.unwrap());
    assert!(!deliver_one(&pool, &inbox).await.unwrap());
    assert_eq!(inbox.0.lock().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn analytics_completion_does_not_suppress_confirmation(pool: PgPool) {
    let event = order_event(&pool).await;
    let clickhouse = ClickHouse::start(true).await;
    clickhouse.client.record_order(&pool, &event).await.unwrap();
    assert!(receipt(&pool, ANALYTICS, &event).await);
    assert!(!receipt(&pool, LEGACY, &event).await);
    assert_eq!(jobs(&pool, &event).await, 0);

    Consumer::Orders
        .process(&pool, "smtp", &event)
        .await
        .unwrap();
    assert!(receipt(&pool, CONFIRMATIONS, &event).await);
    assert_eq!(jobs(&pool, &event).await, 1);
    assert_eq!(clickhouse.rows.lock().unwrap().len(), 1);
}
