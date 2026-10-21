use domain_cart_checkout::market_context::for_cart;
use infra_auth::Error;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn context_reads_current_transaction_settings_without_caching(pool: PgPool) {
    let cart = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.carts(id,guest_hash) VALUES($1,'context-test')")
        .bind(cart)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(matches!(
        for_cart(&mut tx, Uuid::new_v4()).await,
        Err(Error::NotFound)
    ));
    let before = for_cart(&mut tx, cart).await.unwrap();
    sqlx::query("UPDATE cart_checkout.market_configuration SET version=version+1,currency='EGP',region='EG'")
        .execute(&mut *tx).await.unwrap();
    let after = for_cart(&mut tx, cart).await.unwrap();
    assert_eq!(after.store_revision, before.store_revision + 1);
    assert_eq!(after.currency, "EGP");
    assert_eq!(after.country, "EG");
    assert_eq!(after.id, before.id);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn missing_singletons_remain_integrity_errors(pool: PgPool) {
    let cart = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.carts(id,guest_hash) VALUES($1,'context-test')")
        .bind(cart)
        .execute(&pool)
        .await
        .unwrap();
    for statement in [
        "DELETE FROM cart_checkout.market_configuration",
        "DELETE FROM cart_checkout.active_market",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
        assert!(matches!(
            for_cart(&mut tx, cart).await,
            Err(Error::Database(sqlx::Error::RowNotFound))
        ));
        tx.rollback().await.unwrap();
    }
}
