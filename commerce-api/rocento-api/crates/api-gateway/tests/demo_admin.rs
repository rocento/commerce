#[sqlx::test(migrations = "../../migrations")]
async fn demo_enforcement_preserves_identity_disables_alternatives_and_rotates_password(
    pool: sqlx::PgPool,
) {
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let service = domain_admin_iam::Service {
        pool: pool.clone(),
        security,
    };
    let id = service
        .enforce_demo_admin("old@example.test", "initial-test-password".into())
        .await
        .unwrap();
    let other = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'other@example.test','Other','unused',$2)")
        .bind(other).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES('old-session',$1,now()+interval '1 hour')")
        .bind(id).execute(&pool).await.unwrap();
    let updated = service
        .enforce_demo_admin("info@example.test", "replacement-test-password".into())
        .await
        .unwrap();
    assert_eq!(id, updated);
    let accounts: Vec<(uuid::Uuid, String, String)> =
        sqlx::query_as("SELECT id,email,password_hash FROM admin_iam.admin_users WHERE active")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].1, "info@example.test");
    assert!(
        infra_auth::verify_password("replacement-test-password".into(), accounts[0].2.clone())
            .await
            .unwrap()
    );
    assert!(
        !infra_auth::verify_password("initial-test-password".into(), accounts[0].2.clone())
            .await
            .unwrap()
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_iam.sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
    assert!(service
        .seed("extra@example.test", "another-test-password".into())
        .await
        .is_err());
    // An existing matching account takes precedence over the oldest account.
    let matching = service
        .enforce_demo_admin("other@example.test", "replacement-test-password".into())
        .await
        .unwrap();
    assert_eq!(matching, other);
    assert_eq!(
        service
            .enforce_demo_admin("other@example.test", "replacement-test-password".into())
            .await
            .unwrap(),
        other
    );
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_iam.admin_users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 2);
}
