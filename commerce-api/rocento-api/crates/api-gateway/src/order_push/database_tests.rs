use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;
async fn call(
    app: Router,
    method: &str,
    id: Uuid,
    token: &str,
    body: serde_json::Value,
) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method(method)
            .uri(format!("/v1/customer/push-devices/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header("x-commerce-request", "1")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
    .status()
}
#[sqlx::test(migrations = "../../migrations")]
async fn registration_ownership_and_atomic_order_queue(pool: PgPool) {
    let security = infra_auth::Security::new(
        "push-tests-secret-".repeat(3),
        "https://store.example.test".into(),
        true,
    )
    .await
    .unwrap();
    let mut owners = Vec::new();
    let mut tokens = Vec::new();
    for i in 0..2 {
        let id = Uuid::new_v4();
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,first_name,last_name) VALUES($1,$2,'email','!','Push','Test')").bind(id).bind(format!("push-{i}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(id).bind(format!("push-session-{i}")).execute(&pool).await.unwrap();
        tokens.push(security.access_token(id, session).unwrap());
        owners.push(id);
    }
    let state = App::new(
        pool.clone(),
        security,
        vec!["https://store.example.test".into()],
    );
    let app = router(state.clone(), Some(Provider::fixture()));
    let device = Uuid::new_v4();
    let mut registration = json!({"customer_id":owners[0],"platform":"ios","app_id":"com.rocento.grocery","token":"ab".repeat(32),"locale":"en"});
    assert!(call(
        router(state, None),
        "PUT",
        device,
        &tokens[0],
        registration.clone()
    )
    .await
    .is_client_error());
    assert_eq!(
        call(app.clone(), "PUT", device, "invalid", registration.clone()).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(app.clone(), "PUT", device, &tokens[0], registration.clone()).await,
        StatusCode::OK
    );
    registration["customer_id"] = json!(owners[1]);
    assert!(
        call(app.clone(), "PUT", device, &tokens[1], registration.clone())
            .await
            .is_client_error()
    );
    assert_eq!(
        call(app.clone(), "DELETE", device, &tokens[1], json!({})).await,
        StatusCode::OK
    );
    let owner: Uuid =
        sqlx::query_scalar("SELECT customer_id FROM platform.customer_push_devices WHERE id=$1")
            .bind(device)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, owners[0]);
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}','{}',0,0,0,'EGP')").bind(order).bind(owners[0]).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let event = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,reason) VALUES($1,$2,'shipped','test')").bind(event).bind(order).execute(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.order_push_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    for status in ["shipped", "cash_collected"] {
        sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,reason) VALUES($1,$2,$3,'test')").bind(Uuid::new_v4()).bind(order).bind(status).execute(&pool).await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.order_push_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // A deliberately incompatible test signing key fails before any network call.
    let provider = Provider::fixture();
    assert!(deliver_one(&pool, &provider).await.unwrap());
    let state: (String, i32, bool) = sqlx::query_as(
        "SELECT state,attempts,available_at>clock_timestamp() FROM platform.order_push_jobs",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, ("pending".into(), 1, true));
    assert!(!deliver_one(&pool, &provider).await.unwrap());
    sqlx::query(
        "UPDATE platform.order_push_jobs SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(!deliver_one(&pool, &provider).await.unwrap());
    let state: String = sqlx::query_scalar("SELECT state FROM platform.order_push_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "expired");
    // A stale device is excluded from new order events.
    sqlx::query(
        "UPDATE platform.customer_push_devices SET updated_at=clock_timestamp()-interval '31 days'",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,reason) VALUES($1,$2,'delivered','test')").bind(Uuid::new_v4()).bind(order).execute(&pool).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.order_push_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // Same provider token on a new account installation removes the old account's jobs.
    let new_device = Uuid::new_v4();
    registration["customer_id"] = json!(owners[1]);
    assert_eq!(
        call(
            app.clone(),
            "PUT",
            new_device,
            &tokens[1],
            registration.clone()
        )
        .await,
        StatusCode::OK
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.order_push_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        call(app.clone(), "DELETE", new_device, &tokens[1], json!({})).await,
        StatusCode::OK
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.customer_push_devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        call(app, "PUT", new_device, &tokens[1], registration).await,
        StatusCode::OK
    );
    sqlx::query("DELETE FROM customers.sessions WHERE customer_id=$1")
        .bind(owners[1])
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.customer_push_devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
