use domain_theme::{application::*, domain::*, postgres::PostgresRepository};
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Service<PostgresRepository>, Actor) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'theme-test@example.test','Theme admin','unused',$2)").bind(id).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    (
        Service {
            repository: PostgresRepository::new(pool.clone()),
        },
        Actor {
            id,
            permissions: vec!["*".into()],
        },
    )
}
async fn create(s: &Service<PostgresRepository>, who: &Actor) -> Theme {
    s.create(
        Create {
            name: "Reference".into(),
            owner_channel: "storefront".into(),
            source: None,
        },
        who,
    )
    .await
    .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn lifecycle_snapshots_rollback_cache_and_audit(pool: PgPool) {
    let (s, who) = fixture(&pool).await;
    assert!(s.repository.resolve("storefront").await.unwrap().is_none());
    let t = create(&s, &who).await;
    assert!(t.entity_id > 0);
    assert_eq!(s.repository.get(t.id).await.unwrap().entity_id, t.entity_id);
    assert!(s
        .assign(
            "storefront",
            Assign {
                rules: vec![],
                theme_id: Some(t.id),
                expected_revision: 0
            },
            &who
        )
        .await
        .is_err());
    let v1 = s
        .publish(
            t.id,
            Publish {
                expected_revision: 1,
                source_version: None,
            },
            &who,
        )
        .await
        .unwrap();
    assert!(v1.entity_id > 0);
    s.assign(
        "storefront",
        Assign {
            rules: vec![],
            theme_id: Some(t.id),
            expected_revision: 0,
        },
        &who,
    )
    .await
    .unwrap();
    assert_eq!(
        s.repository
            .resolve("storefront")
            .await
            .unwrap()
            .unwrap()
            .id,
        v1.id
    );
    let t = s.repository.get(t.id).await.unwrap();
    let mut config = t.configuration.clone();
    config
        .tokens
        .insert("color.primary".into(), "#112233".into());
    let t = s
        .save(
            t.id,
            Update {
                expected_revision: t.revision,
                configuration: config,
            },
            &who,
        )
        .await
        .unwrap();
    assert_eq!(
        s.preview(t.id, &who).await.unwrap().tokens["color.primary"],
        "#112233"
    );
    assert_eq!(
        s.repository
            .resolve("storefront")
            .await
            .unwrap()
            .unwrap()
            .id,
        v1.id
    );
    let v2 = s
        .publish(
            t.id,
            Publish {
                expected_revision: t.revision,
                source_version: None,
            },
            &who,
        )
        .await
        .unwrap();
    assert_eq!(
        s.repository
            .resolve("storefront")
            .await
            .unwrap()
            .unwrap()
            .id,
        v2.id
    );
    let v3 = s
        .publish(
            t.id,
            Publish {
                expected_revision: t.revision + 1,
                source_version: Some(v1.id),
            },
            &who,
        )
        .await
        .unwrap();
    assert_eq!(v3.number, 3);
    assert_eq!(v3.configuration.tokens, v1.configuration.tokens);
    assert_eq!(
        s.repository
            .resolve("storefront")
            .await
            .unwrap()
            .unwrap()
            .id,
        v3.id
    );
    assert!(
        sqlx::query("UPDATE theme.versions SET number=99 WHERE id=$1")
            .bind(v1.id)
            .execute(&pool)
            .await
            .is_err()
    );
    let audit: i64 =
        sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE entity_id=$1")
            .bind(t.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit, 6);
    assert_eq!(s.versions(t.id, &who).await.unwrap().len(), 3);
    assert_eq!(s.version(t.id, v1.id, &who).await.unwrap().number, 1);
    let copy = s
        .create(
            Create {
                name: "Duplicate".into(),
                owner_channel: "storefront".into(),
                source: Some(t.id),
            },
            &who,
        )
        .await
        .unwrap();
    assert_ne!(copy.id, t.id);
    assert!(copy.published_version.is_none());
    assert_eq!(
        copy.configuration.tokens,
        s.repository.get(t.id).await.unwrap().configuration.tokens
    );
    assert!(matches!(
        s.version(copy.id, v1.id, &who).await,
        Err(Error::NotFound)
    ));
    s.assign(
        "storefront",
        Assign {
            rules: vec![],
            theme_id: None,
            expected_revision: 1,
        },
        &who,
    )
    .await
    .unwrap();
    assert!(s.repository.resolve("storefront").await.unwrap().is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn missing_assets_cannot_be_saved_and_stale_assignment_is_rejected(pool: PgPool) {
    let (s, who) = fixture(&pool).await;
    let t = create(&s, &who).await;
    let mut configuration = t.configuration.clone();
    let hero = &mut configuration.pages.get_mut("home").unwrap()[0];
    hero.settings
        .insert("image".into(), Uuid::new_v4().to_string().into());
    hero.settings
        .insert("alt".into(), "Product photograph".into());
    assert!(matches!(
        s.save(
            t.id,
            Update {
                expected_revision: 1,
                configuration
            },
            &who
        )
        .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(s.repository.get(t.id).await.unwrap().revision, 1);
    s.publish(
        t.id,
        Publish {
            expected_revision: 1,
            source_version: None,
        },
        &who,
    )
    .await
    .unwrap();
    let first = s
        .assign(
            "storefront",
            Assign {
                rules: vec![],
                expected_revision: 0,
                theme_id: Some(t.id),
            },
            &who,
        )
        .await
        .unwrap();
    assert_eq!(first.revision, 1);
    assert!(matches!(
        s.assign(
            "storefront",
            Assign {
                rules: vec![],
                expected_revision: 0,
                theme_id: None
            },
            &who
        )
        .await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        s.resolve("storefront").await.unwrap().0,
        s.repository.get(t.id).await.unwrap().published_version
    );
    let replica = Service {
        repository: PostgresRepository::new(pool.clone()),
    };
    let current = s.repository.get(t.id).await.unwrap();
    let v2 = s
        .publish(
            t.id,
            Publish {
                expected_revision: current.revision,
                source_version: None,
            },
            &who,
        )
        .await
        .unwrap();
    assert_eq!(replica.resolve("storefront").await.unwrap().0, Some(v2.id));
    assert_eq!(s.resolve("storefront").await.unwrap().0, Some(v2.id));
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_edits_conflict_and_scope_is_enforced(pool: PgPool) {
    let (s, who) = fixture(&pool).await;
    let t = create(&s, &who).await;
    let (a, b) = tokio::join!(
        s.save(
            t.id,
            Update {
                expected_revision: 1,
                configuration: t.configuration.clone()
            },
            &who
        ),
        s.save(
            t.id,
            Update {
                expected_revision: 1,
                configuration: t.configuration.clone()
            },
            &who
        )
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let denied = Actor {
        id: who.id,
        permissions: vec![
            "theme.read@other".into(),
            "theme.publish@other".into(),
            "theme.assign@other".into(),
        ],
    };
    assert!(s.list(&denied).await.unwrap().is_empty());
    assert!(matches!(
        s.preview(t.id, &denied).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        s.publish(
            t.id,
            Publish {
                expected_revision: 2,
                source_version: None
            },
            &denied
        )
        .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        s.assign(
            "storefront",
            Assign {
                rules: vec![],
                expected_revision: 0,
                theme_id: Some(t.id)
            },
            &denied
        )
        .await,
        Err(Error::Forbidden)
    ));
    let mut invalid = t.configuration.clone();
    invalid.pages.get_mut("home").unwrap()[0]
        .settings
        .insert("href".into(), "javascript:alert(1)".into());
    assert!(s
        .save(
            t.id,
            Update {
                expected_revision: 2,
                configuration: invalid
            },
            &who
        )
        .await
        .is_err());
    assert_eq!(s.repository.get(t.id).await.unwrap().revision, 2);
}
#[sqlx::test(migrations = "../../migrations")]
async fn publishing_shared_theme_requires_all_channels(pool: PgPool) {
    let (s, who) = fixture(&pool).await;
    sqlx::query("INSERT INTO inventory.sales_channel_stock_links(channel_id,stock_id) VALUES('second','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap();
    let t = create(&s, &who).await;
    s.publish(
        t.id,
        Publish {
            expected_revision: 1,
            source_version: None,
        },
        &who,
    )
    .await
    .unwrap();
    s.assign(
        "second",
        Assign {
            rules: vec![],
            expected_revision: 0,
            theme_id: Some(t.id),
        },
        &who,
    )
    .await
    .unwrap();
    let limited = Actor {
        id: who.id,
        permissions: vec!["theme.publish@storefront".into()],
    };
    assert!(matches!(
        s.publish(
            t.id,
            Publish {
                expected_revision: 3,
                source_version: None
            },
            &limited
        )
        .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        s.publish(
            t.id,
            Publish {
                expected_revision: 2,
                source_version: None
            },
            &who
        )
        .await,
        Err(Error::Conflict)
    ));
}
