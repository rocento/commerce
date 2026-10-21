use domain_customers::deletion::{self, PolicyInput};
use sqlx::PgPool;
use uuid::Uuid;
async fn fixture(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
    let admin = Uuid::new_v4();
    let customer = Uuid::new_v4();
    let request = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'admin@example.test','Admin','hash','00000000-0000-0000-0000-000000000001')").bind(admin).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,'erase@example.test','email','hash')").bind(customer).execute(pool).await.unwrap();
    let policy = deletion::configure(
        pool,
        admin,
        PolicyInput {
            legal_entity: "Test merchant".into(),
            jurisdictions: vec!["Configured jurisdiction".into()],
            financial_days: 365,
            retain_contact: false,
            retain_address: false,
        },
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO customers.deletion_requests(id,merchant_id,customer_id,policy_id,receipt_hash,state) VALUES($1,$2,$3,$4,'receipt','requested')").bind(request).bind(policy.merchant_id).bind(customer).bind(policy.id).execute(pool).await.unwrap();
    sqlx::query("UPDATE customers.customers SET deletion_requested_at=now() WHERE id=$1")
        .bind(customer)
        .execute(pool)
        .await
        .unwrap();
    (admin, customer, request)
}
#[sqlx::test(migrations = "../../migrations")]
async fn erases_profile_and_requires_every_processor(pool: PgPool) {
    let (_, customer, request) = fixture(&pool).await;
    assert!(deletion::erase_commerce(&pool, request).await.unwrap());
    assert!(deletion::erase_commerce(&pool, request).await.unwrap());
    let email: String = sqlx::query_scalar("SELECT email FROM customers.customers WHERE id=$1")
        .bind(customer)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(email.ends_with("@deleted.invalid"));
    assert!(
        sqlx::query("INSERT INTO reviews.wishlist(customer_id,product_id) VALUES($1,$2)")
            .bind(customer)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .is_err()
    );
    deletion::finish(&pool, request).await.unwrap();
    let complete: bool =
        sqlx::query_scalar("SELECT state='complete' FROM customers.deletion_requests WHERE id=$1")
            .bind(request)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!complete);
    for stage in ["assistant", "analytics", "engagement"] {
        deletion::acknowledge(&pool, request, stage).await.unwrap();
    }
    deletion::finish(&pool, request).await.unwrap();
    let complete: bool =
        sqlx::query_scalar("SELECT state='complete' FROM customers.deletion_requests WHERE id=$1")
            .bind(request)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(complete);
}
#[sqlx::test(migrations = "../../migrations")]
async fn policy_versions_and_expiry(pool: PgPool) {
    let (admin, _, request) = fixture(&pool).await;
    let old = deletion::policy(&pool).await.unwrap().unwrap();
    let new = deletion::configure(
        &pool,
        admin,
        PolicyInput {
            legal_entity: "Changed".into(),
            jurisdictions: vec!["Other".into()],
            financial_days: 0,
            retain_contact: false,
            retain_address: false,
        },
    )
    .await
    .unwrap();
    assert_ne!(old.id, new.id);
    let pinned: Uuid =
        sqlx::query_scalar("SELECT policy_id FROM customers.deletion_requests WHERE id=$1")
            .bind(request)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(old.id, pinned);
    assert!(
        sqlx::query("UPDATE customers.retention_policies SET financial_days=99 WHERE id=$1")
            .bind(old.id)
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query("INSERT INTO customers.retained_transactions VALUES($1,$2,'{}',now()-interval '1 day'),($1,$3,'{}',now()+interval '1 day')").bind(request).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    assert_eq!(deletion::purge(&pool).await.unwrap(), 1);
    deletion::retry(&pool, request).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn legal_hold_defers_erasure(pool: PgPool) {
    let (_, customer, request) = fixture(&pool).await;
    sqlx::query(
        "UPDATE customers.deletion_requests SET hold_until=now()+interval '1 day' WHERE id=$1",
    )
    .bind(request)
    .execute(&pool)
    .await
    .unwrap();
    assert!(!deletion::erase_commerce(&pool, request).await.unwrap());
    let email: String = sqlx::query_scalar("SELECT email FROM customers.customers WHERE id=$1")
        .bind(customer)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(email, "erase@example.test");
    sqlx::query(
        "UPDATE customers.deletion_requests SET hold_until=now()-interval '1 day' WHERE id=$1",
    )
    .bind(request)
    .execute(&pool)
    .await
    .unwrap();
    assert!(deletion::erase_commerce(&pool, request).await.unwrap());
}
#[sqlx::test(migrations = "../../migrations")]
async fn open_orders_wait_and_archive_only_policy_fields(pool: PgPool) {
    let (_, customer, request) = fixture(&pool).await;
    let order = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('commerce.erasure','on',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,contact,location,subtotal,delivery_fee,total,currency,gift_message) VALUES($1,$2,$3,$4,'placed','{\"email\":\"private@example.test\"}','{\"delivery_instructions\":\"private\"}',0,0,0,'USD','private gift')").bind(order).bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert!(!deletion::erase_commerce(&pool, request).await.unwrap());
    sqlx::query("UPDATE orders.orders SET status='cancelled' WHERE id=$1")
        .bind(order)
        .execute(&pool)
        .await
        .unwrap();
    assert!(deletion::erase_commerce(&pool, request).await.unwrap());
    let record: serde_json::Value = sqlx::query_scalar(
        "SELECT record FROM customers.retained_transactions WHERE request_id=$1",
    )
    .bind(request)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(record["contact"].is_null());
    assert!(record["address"].is_null());
    assert!(!record.to_string().contains("private"));
    let anonymized:bool=sqlx::query_scalar("SELECT customer_id<>$2 AND contact='{}' AND location='{}' AND gift_message IS NULL FROM orders.orders WHERE id=$1").bind(order).bind(customer).fetch_one(&pool).await.unwrap();
    assert!(anonymized);
}
#[sqlx::test(migrations = "../../migrations")]
async fn reauthentication_receipt_replay_and_revocation(pool: PgPool) {
    let (admin, _, _) = fixture(&pool).await;
    let security = infra_auth::Security::new(
        "deletion-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let service = domain_customers::Service {
        pool: pool.clone(),
        security,
    };
    let customer = Uuid::new_v4();
    let password = "Deletion test password 123!";
    let hash = infra_auth::hash_password(password.to_string())
        .await
        .unwrap();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,'login@example.test','email',$2)").bind(customer).bind(hash).execute(&pool).await.unwrap();
    let login = service
        .login(domain_customers::Credentials {
            identifier: "login@example.test".into(),
            password: password.into(),
        })
        .await
        .unwrap();
    let policy = deletion::policy(&pool).await.unwrap().unwrap();
    let id = Uuid::new_v4();
    let receipt = "a".repeat(64);
    let make = |password: &str| deletion::Request {
        request_id: id,
        policy_id: policy.id,
        receipt_token: receipt.clone(),
        password: password.into(),
        confirm: true,
    };
    assert!(service
        .request_deletion(&login.body.access_token, make("wrong"))
        .await
        .is_err());
    let status = service
        .request_deletion(&login.body.access_token, make(password))
        .await
        .unwrap();
    assert_eq!(status.id, id);
    assert!(service
        .authenticate(&login.body.access_token)
        .await
        .is_err());
    assert_eq!(
        service
            .request_deletion("expired", make("ignored replay"))
            .await
            .unwrap()
            .id,
        id
    );
    assert!(deletion::status(
        &pool,
        &deletion::Receipt {
            request_id: id,
            receipt_token: "b".repeat(64)
        }
    )
    .await
    .is_err());
    let _ = admin;
}
#[sqlx::test(migrations = "../../engagement-migrations")]
async fn engagement_erasure_is_isolated_and_tombstoned(pool: PgPool) {
    let customer = Uuid::new_v4();
    let other = Uuid::new_v4();
    for owner in [customer, other] {
        sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source) VALUES($1,$2,$3,'page_view','/','direct')").bind(owner).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    }
    api_gateway::account_deletion::erase_engagement(&pool, customer)
        .await
        .unwrap();
    api_gateway::account_deletion::erase_engagement(&pool, customer)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.journey_events WHERE customer_id=$1")
            .bind(other)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let inserted=sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source) VALUES($1,$2,$3,'page_view','/','direct')").bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    assert_eq!(inserted.rows_affected(), 0);
}
