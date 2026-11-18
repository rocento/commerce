//! Real PostgreSQL admission regressions: bounded acquisitions without cached authority.
use domain_admin_operations::meta::{Consent, Service as Meta};
use infra_auth::{secrets::Vault, Error, Security};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use uuid::Uuid;

async fn counted_pool(pool: &PgPool) -> (PgPool, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let limited = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .before_acquire(move |_, _| {
            observed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(true) })
        })
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    drop(limited.acquire().await.unwrap());
    count.store(0, Ordering::SeqCst);
    (limited, count)
}

async fn fixture(pool: &PgPool) -> (Uuid, Uuid) {
    let customer = Uuid::new_v4();
    let quote = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','!',true)")
        .bind(customer).bind(format!("{customer}@example.test")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) VALUES($1,$2,gen_random_uuid(),gen_random_uuid(),'{}',now()+interval '1 hour')")
        .bind(quote).bind(customer).execute(pool).await.unwrap();
    (customer, quote)
}

fn meta(pool: PgPool) -> Meta {
    Meta {
        pool,
        vault: Some(Vault::from_hex(&"ab".repeat(32)).unwrap()),
    }
}

async fn placed(pool: &PgPool, customer: Uuid, quote: Uuid) {
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES(gen_random_uuid(),$1,$2,gen_random_uuid(),'placed','{}','{}',10,0,10,'USD')")
        .bind(customer).bind(quote).execute(pool).await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn authentication_uses_one_acquisition_and_rechecks_live_authority(pool: PgPool) {
    let (customer, _) = fixture(&pool).await;
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')")
        .bind(session).bind(customer).bind(session.to_string()).execute(&pool).await.unwrap();
    let security = Security::new(
        "admission-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let token = security.access_token(customer, session).unwrap();
    let wrong_customer = security.access_token(Uuid::new_v4(), session).unwrap();
    let (limited, count) = counted_pool(&pool).await;
    let service = domain_customers::Service {
        pool: limited.clone(),
        security,
    };
    assert_eq!(service.require_verified(&token).await.unwrap().id, customer);
    let first_acquisitions = count.load(Ordering::SeqCst);
    assert!(matches!(
        service.authenticate(&wrong_customer).await,
        Err(Error::Unauthorized)
    ));
    sqlx::query("UPDATE customers.customers SET verified=false WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        service.require_verified(&token).await,
        Err(Error::Forbidden)
    ));
    sqlx::query(
        "UPDATE customers.customers SET verified=true,deletion_requested_at=now() WHERE id=$1",
    )
    .bind(customer)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        service.authenticate(&token).await,
        Err(Error::Unauthorized)
    ));
    sqlx::query("UPDATE customers.customers SET deletion_requested_at=NULL WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE customers.sessions SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        service.authenticate(&token).await,
        Err(Error::Unauthorized)
    ));
    sqlx::query("UPDATE customers.sessions SET expires_at=now()+interval '1 hour' WHERE id=$1")
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();
    assert!(service.authenticate(&token).await.is_ok());
    sqlx::query("DELETE FROM customers.sessions WHERE id=$1")
        .bind(session)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        service.authenticate(&token).await,
        Err(Error::Unauthorized)
    ));
    limited.close().await;
    assert_eq!(
        first_acquisitions, 1,
        "authentication must enter the pool queue once"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn default_consent_uses_one_acquisition(pool: PgPool) {
    let (customer, quote) = fixture(&pool).await;
    let (limited, count) = counted_pool(&pool).await;
    let service = meta(limited.clone());
    tokio::time::timeout(
        Duration::from_secs(3),
        service.record_consent(customer, quote, Consent::default()),
    )
    .await
    .unwrap()
    .unwrap();
    let acquisitions = count.load(Ordering::SeqCst);
    let row: (bool, bool, Option<Vec<u8>>) = sqlx::query_as("SELECT conversions,whatsapp,phone_ciphertext FROM platform.meta_checkout_consent WHERE quote_id=$1").bind(quote).fetch_one(&pool).await.unwrap();
    assert_eq!(row, (false, false, None));
    limited.close().await;
    assert_eq!(
        acquisitions, 1,
        "ordinary consent must enter the pool queue once"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn whatsapp_consent_uses_one_connection_without_nested_acquisition(pool: PgPool) {
    let (customer, quote) = fixture(&pool).await;
    sqlx::query("UPDATE platform.meta_settings SET config='{\"whatsapp_enabled\":true}'")
        .execute(&pool)
        .await
        .unwrap();
    let (limited, count) = counted_pool(&pool).await;
    let service = meta(limited.clone());
    let consent = Consent {
        whatsapp: true,
        phone: "+201012345678".into(),
        ..Consent::default()
    };
    tokio::time::timeout(
        Duration::from_secs(3),
        service.record_consent(customer, quote, consent),
    )
    .await
    .unwrap()
    .unwrap();
    let acquisitions = count.load(Ordering::SeqCst);
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT phone_ciphertext FROM platform.meta_checkout_consent WHERE quote_id=$1",
    )
    .bind(quote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("201012345678"));
    assert_eq!(
        meta(pool.clone()).open(&encrypted).await.unwrap(),
        b"+201012345678"
    );
    assert!(service
        .vault
        .as_ref()
        .unwrap()
        .open(&format!("meta:{}", Uuid::new_v4()), &encrypted)
        .is_err());
    limited.close().await;
    assert_eq!(
        acquisitions, 1,
        "WhatsApp must not reacquire a connection to seal its phone"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn consent_replay_and_validation_precedence_are_preserved(pool: PgPool) {
    let (customer, quote) = fixture(&pool).await;
    let mut service = meta(pool.clone());
    let opted_in = Consent {
        whatsapp: true,
        phone: "invalid".into(),
        ..Consent::default()
    };
    let foreign = Uuid::new_v4();
    assert!(
        matches!(service.record_consent(foreign, quote, opted_in.clone()).await, Err(Error::Invalid(m)) if m == "The selected Meta service is unavailable")
    );
    sqlx::query("UPDATE platform.meta_settings SET config='{\"whatsapp_enabled\":true}'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        matches!(service.record_consent(foreign, quote, opted_in.clone()).await, Err(Error::Invalid(m)) if m == "Enter a WhatsApp phone number with country code")
    );
    assert!(matches!(
        service
            .record_consent(foreign, quote, Consent::default())
            .await,
        Err(Error::NotFound)
    ));
    placed(&pool, customer, quote).await;
    sqlx::query("UPDATE platform.meta_settings SET config='{\"whatsapp_enabled\":\"invalid\"}'")
        .execute(&pool)
        .await
        .unwrap();
    service.vault = None;
    service
        .record_consent(customer, quote, opted_in.clone())
        .await
        .unwrap();
    assert!(matches!(
        service
            .record_consent(foreign, quote, Consent::default())
            .await,
        Err(Error::Internal)
    ));
    sqlx::query("DELETE FROM platform.meta_settings")
        .execute(&pool)
        .await
        .unwrap();
    service
        .record_consent(customer, quote, opted_in)
        .await
        .unwrap();
    assert!(matches!(
        service
            .record_consent(foreign, quote, Consent::default())
            .await,
        Err(Error::Database(sqlx::Error::RowNotFound))
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_consent_cannot_reverse_opt_out_or_rewrite_processed_receipts(pool: PgPool) {
    let (customer, quote) = fixture(&pool).await;
    sqlx::query("UPDATE platform.meta_settings SET config='{\"conversions_enabled\":true}'")
        .execute(&pool)
        .await
        .unwrap();
    let a = meta(pool.clone());
    let b = meta(pool.clone());
    let (first, second) = tokio::join!(
        a.record_consent(
            customer,
            quote,
            Consent {
                conversions: true,
                ..Consent::default()
            }
        ),
        b.record_consent(customer, quote, Consent::default())
    );
    first.unwrap();
    second.unwrap();
    let allowed: bool = sqlx::query_scalar(
        "SELECT conversions FROM platform.meta_checkout_consent WHERE quote_id=$1",
    )
    .bind(quote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!allowed);
    sqlx::query("UPDATE platform.meta_checkout_consent SET processed_at=now() WHERE quote_id=$1")
        .bind(quote)
        .execute(&pool)
        .await
        .unwrap();
    let before: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM platform.meta_checkout_consent c WHERE quote_id=$1",
    )
    .bind(quote)
    .fetch_one(&pool)
    .await
    .unwrap();
    a.record_consent(
        customer,
        quote,
        Consent {
            conversions: true,
            ..Consent::default()
        },
    )
    .await
    .unwrap();
    let after: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM platform.meta_checkout_consent c WHERE quote_id=$1",
    )
    .bind(quote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, after);
}
