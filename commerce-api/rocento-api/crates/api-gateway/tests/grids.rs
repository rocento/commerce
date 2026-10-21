use api_gateway::{exports, grids};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn rejects_untrusted_identifiers_and_invalid_options() {
    assert!(grids::definition("customers.sessions").is_err());
    assert!(grids::validate(
        "catalog",
        &grids::Request {
            limit: Some(201),
            ..Default::default()
        }
    )
    .is_err());
    assert!(grids::validate(
        "catalog",
        &grids::Request {
            sort: Some("name; DROP TABLE catalog.products".into()),
            ..Default::default()
        }
    )
    .is_err());
    assert!(grids::validate(
        "catalog",
        &grids::Request {
            status: Some("pending".into()),
            ..Default::default()
        }
    )
    .is_err());
    let mut input = exports::Input {
        grid: "users".into(),
        request: Default::default(),
        columns: vec!["password_hash".into()],
        format: "csv".into(),
    };
    assert!(exports::validate(&input).is_err());
    input.columns = vec!["id".into(), "id".into()];
    assert!(exports::validate(&input).is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn keyset_traversal_ties_reverse_and_cursor_scope(pool: PgPool) {
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) SELECT md5(n::text)::uuid,CASE WHEN n%2=0 THEN 'same' ELSE 'other' END,n::text FROM generate_series(1,501) n").execute(&pool).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();
    for descending in [false, true] {
        let mut r = grids::Request {
            sort: Some("name".into()),
            limit: Some(37),
            descending,
            ..Default::default()
        };
        let mut ids = std::collections::HashSet::new();
        loop {
            let p = grids::page(&mut conn, "categories", &r, None)
                .await
                .unwrap();
            assert!(p.items.len() <= 37);
            assert_eq!(p.total_count, 501);
            for item in p.items {
                assert!(ids.insert(item["id"].clone().to_string()));
            }
            r.cursor = p.next_cursor;
            if r.cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 501);
    }
    let mut r = grids::Request {
        limit: Some(3),
        ..Default::default()
    };
    r.cursor = grids::page(&mut conn, "categories", &r, None)
        .await
        .unwrap()
        .next_cursor;
    r.q = "changed".into();
    assert!(grids::validate("categories", &r).is_err());
    let p = grids::page(
        &mut conn,
        "categories",
        &grids::Request {
            q: "same".into(),
            limit: Some(200),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(p.items.len(), 200);
    assert_eq!(p.total_count, 250);
    assert!(p.items.iter().all(|i| i["name"] == "same"));
    assert!(grids::page(&mut conn, "support", &Default::default(), None)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn queue_claim_is_exclusive_and_recovers_stale_workers(pool: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'worker@test.invalid','worker','unused',$2)").bind(owner).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.export_jobs(id,owner_id,grid,request,columns,format) VALUES($1,$2,'categories',$3,$4,'csv')").bind(id).bind(owner).bind(json!({})).bind(json!(["id"])).execute(&pool).await.unwrap();
    let (a, b) = tokio::join!(exports::claim(&pool), exports::claim(&pool));
    assert_eq!(a.unwrap().is_some() as u8 + b.unwrap().is_some() as u8, 1);
    sqlx::query(
        "UPDATE admin_iam.export_jobs SET heartbeat_at=now()-interval '11 minutes' WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(exports::claim(&pool).await.unwrap().is_none());
    let status: String = sqlx::query_scalar("SELECT status FROM admin_iam.export_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "failed");
}

#[sqlx::test(migrations = "../../migrations")]
async fn export_http_enforces_ownership_permissions_and_ready_state(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;

    let security = infra_auth::Security::new(
        "a-test-secret-of-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::identity::App::new(pool.clone(), security, vec![]);
    let mut owners = vec![];
    for token in ["owner", "other"] {
        let id = Uuid::new_v4();
        owners.push(id);
        sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'test','unused',$3)").bind(id).bind(format!("{token}@test.invalid")).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(token)).bind(id).execute(&pool).await.unwrap();
    }
    let router = exports::router(app.clone()).merge(grids::router(app));
    let input = json!({"grid":"categories","request":{},"columns":["id","name"],"format":"csv"});
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/exports")
                .header("cookie", "admin_session=owner")
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let j: serde_json::Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let id = j["id"].as_str().unwrap();
    for (token, suffix, status) in [("other", "", 404), ("owner", "/download", 409)] {
        let r = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/admin/exports/{id}{suffix}"))
                    .header("cookie", format!("admin_session={token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), status);
    }
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/admin/grids/users")
                .header("cookie", "admin_session=owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let text =
        String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(!text.contains("password_hash"));
    let job_id: Uuid = id.parse().unwrap();
    sqlx::query("INSERT INTO admin_iam.export_chunks(job_id,sequence,data) VALUES($1,0,$2)")
        .bind(job_id)
        .bind(b"id,name\n".as_slice())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE admin_iam.export_jobs SET status='completed',bytes_written=8 WHERE id=$1")
        .bind(job_id)
        .execute(&pool)
        .await
        .unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/admin/exports/{id}/download"))
                .header("cookie", "admin_session=owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-length"], "8");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"id,name\n"
    );
    let leased: bool =
        sqlx::query_scalar("SELECT download_until>now() FROM admin_iam.export_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(leased);
    sqlx::query("UPDATE admin_iam.admin_users SET role_id='00000000-0000-0000-0000-000000000002' WHERE id=$1").bind(owners[0]).execute(&pool).await.unwrap();
    let r = router
        .oneshot(
            Request::builder()
                .uri(format!("/v1/admin/exports/{id}"))
                .header("cookie", "admin_session=owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
}

#[sqlx::test(migrations = "../../migrations")]
async fn every_grid_projection_executes_with_bounded_pages(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    for name in [
        "catalog",
        "inventory",
        "categories",
        "attributes",
        "media",
        "orders",
        "users",
        "roles",
        "audit",
        "content",
        "reviews",
        "promotions",
        "tax",
        "support",
        "attribute-definitions",
        "adjustments",
        "reservations",
        "order-comments",
        "sources",
        "stocks",
        "source-items",
        "delivery-areas",
        "cms-revisions",
        "cms-releases",
    ] {
        let mut r = grids::Request {
            limit: Some(2),
            ..Default::default()
        };
        if ["adjustments", "reservations", "source-items"].contains(&name) {
            r.product_id = Some(Uuid::new_v4());
        }
        if name == "order-comments" {
            r.order_id = Some(Uuid::new_v4());
        }
        if ["cms-revisions", "cms-releases"].contains(&name) {
            r.document_id = Some(Uuid::new_v4());
        }
        for sort in grids::sorts(name).unwrap() {
            r.sort = Some(sort.into());
            let page = grids::page(&mut conn, name, &r, Some(Uuid::new_v4()))
                .await
                .unwrap_or_else(|e| panic!("{name}/{sort}: {e}"));
            assert!(page.items.len() <= 2);
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn order_rows_keep_contact_and_exact_money_and_cms_history_is_bounded(pool: PgPool) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}',$5,10.23,0,10.23,'USD')").bind(id).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(json!({"email":"buyer@test.invalid"})).execute(&pool).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let p = grids::page(&mut conn, "orders", &Default::default(), None)
        .await
        .unwrap();
    assert_eq!(p.items[0]["contact"]["email"], "buyer@test.invalid");
    assert_eq!(p.items[0]["total"], "10.23");
    let doc = Uuid::new_v4();
    sqlx::query("INSERT INTO cms.documents(id,key,kind,version) VALUES($1,'history','page',501)")
        .bind(doc)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) SELECT md5(n::text)::uuid,$1,n,'Revision','[]',$2 FROM generate_series(1,501)n").bind(doc).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let detail = domain_cms::Service { pool: pool.clone() }
        .detail(doc)
        .await
        .unwrap();
    assert_eq!(detail.revisions.len(), 50);
    assert_eq!(detail.revisions[0].version, 501);
    let r = grids::Request {
        document_id: Some(doc),
        sort: Some("version".into()),
        descending: true,
        limit: Some(200),
        ..Default::default()
    };
    let p = grids::page(&mut conn, "cms-revisions", &r, None)
        .await
        .unwrap();
    assert_eq!(p.items.len(), 200);
    assert_eq!(p.total_count, 501);
    assert_eq!(p.items[0]["version"], 501);
    assert!(p.next_cursor.is_some());
}

// Opt-in capacity fixture: never seeds or modifies the application's database.
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Creates a ten-million-row isolated fixture; reserve database disk and run explicitly"]
async fn ten_million_record_seek_plan(pool: PgPool) {
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) SELECT lpad(to_hex(n),32,'0')::uuid,'Capacity fixture',n::text FROM generate_series(1::bigint,10000000::bigint)n").execute(&pool).await.unwrap();
    sqlx::query("ANALYZE catalog.categories")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let mut r = grids::Request {
        limit: Some(200),
        ..Default::default()
    };
    let first = grids::page(&mut conn, "categories", &r, None)
        .await
        .unwrap();
    let mut cursor: serde_json::Value =
        serde_json::from_str(first.next_cursor.as_ref().unwrap()).unwrap();
    cursor["id"] = json!(Uuid::from_u128(9_000_000));
    r.cursor = Some(cursor.to_string());
    let start = std::time::Instant::now();
    let page = grids::page(&mut conn, "categories", &r, None)
        .await
        .unwrap();
    eprintln!("200-row page after 9M records: {:?}", start.elapsed());
    assert_eq!(page.items.len(), 200);
    let plan:serde_json::Value=sqlx::query_scalar("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,name,slug FROM catalog.categories WHERE id>$1 ORDER BY id LIMIT 201").bind(Uuid::from_u128(9_000_000)).fetch_one(&mut *conn).await.unwrap();
    eprintln!("{plan}");
    assert!(plan.to_string().contains("Index Scan"));
    assert!(!plan.to_string().contains("Seq Scan"));
}

#[test]
fn audit_investigation_filters_are_scoped_and_validated() {
    let mut request = grids::Request {
        action: Some("admin.role_updated".into()),
        actor_id: Some(Uuid::new_v4()),
        entity_id: Some(Uuid::new_v4()),
        created_from: Some("2026-10-01T00:00:00Z".parse().unwrap()),
        created_to: Some("2026-10-02T00:00:00Z".parse().unwrap()),
        sort: Some("created_at".into()),
        descending: true,
        ..Default::default()
    };
    assert!(grids::validate("audit", &request).is_ok());
    assert!(grids::validate("orders", &request).is_err());
    request.created_to = request.created_from;
    assert!(grids::validate("audit", &request).is_err());
    request.created_to = None;
    request.action = Some(" ".into());
    assert!(grids::validate("audit", &request).is_err());
    request.action = Some("a".repeat(201));
    assert!(grids::validate("audit", &request).is_err());
    let roles = grids::Request {
        system: Some(false),
        ..Default::default()
    };
    assert!(grids::validate("roles", &roles).is_ok());
    assert!(grids::validate("audit", &roles).is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_labels_resolve_without_changing_record_identity(pool: PgPool) {
    let actor = Uuid::new_v4();
    let role = Uuid::from_u128(2);
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'audit@example.com','Audit reviewer','unused',$2)")
        .bind(actor).bind(role).execute(&pool).await.unwrap();
    for (action, entity) in [
        ("admin.logged_in", actor),
        ("admin.role_updated", role),
        ("assistant.tracking.read_requested", Uuid::new_v4()),
    ] {
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,'{}')")
            .bind(Uuid::new_v4()).bind(actor).bind(action).bind(entity).execute(&pool).await.unwrap();
    }
    let mut conn = pool.acquire().await.unwrap();
    let page = grids::page(
        &mut conn,
        "audit",
        &grids::Request {
            actor_id: Some(actor),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(page.total_count, 3);
    assert_eq!(page.items.len(), 3);
    for event in page.items {
        assert_eq!(event["actor_id"], actor.to_string());
        assert_eq!(event["actor_name"], "Audit reviewer");
        assert_eq!(event["actor_email"], "audit@example.com");
        match event["action"].as_str().unwrap() {
            "admin.logged_in" => {
                assert_eq!(event["entity_id"], actor.to_string());
                assert_eq!(event["entity_name"], "Audit reviewer");
                assert_eq!(event["entity_type"], "Administrator");
            }
            "admin.role_updated" => {
                assert_eq!(event["entity_id"], role.to_string());
                assert_eq!(event["entity_name"], "Auditor");
                assert_eq!(event["entity_type"], "Role");
            }
            _ => assert!(event["entity_name"].is_null()),
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_investigation_filters_match_rows_counts_and_cursor_scope(pool: PgPool) {
    let entity = Uuid::new_v4();
    for (action, time) in [
        ("admin.role_updated", "2026-10-01T00:00:00Z"),
        ("admin.role_updated", "2026-10-01T12:00:00Z"),
        ("admin.role_updated", "2026-10-02T00:00:00Z"),
        ("admin.role_created", "2026-10-01T12:00:00Z"),
    ] {
        sqlx::query("INSERT INTO admin_iam.audit_log(id,action,entity_id,details,created_at) VALUES($1,$2,$3,'{}',$4)")
            .bind(Uuid::new_v4()).bind(action).bind(entity).bind(time.parse::<chrono::DateTime<chrono::Utc>>().unwrap()).execute(&pool).await.unwrap();
    }
    let mut request = grids::Request {
        action: Some("admin.role_updated".into()),
        entity_id: Some(entity),
        created_from: Some("2026-10-01T00:00:00Z".parse().unwrap()),
        created_to: Some("2026-10-02T00:00:00Z".parse().unwrap()),
        sort: Some("created_at".into()),
        descending: true,
        limit: Some(1),
        ..Default::default()
    };
    let mut conn = pool.acquire().await.unwrap();
    let first = grids::page(&mut conn, "audit", &request, None)
        .await
        .unwrap();
    assert_eq!(first.total_count, 2);
    assert_eq!(first.items.len(), 1);
    request.cursor = first.next_cursor;
    assert!(request.cursor.is_some());
    let next = grids::page(&mut conn, "audit", &request, None)
        .await
        .unwrap();
    assert_eq!(next.total_count, 2);
    assert_ne!(first.items[0]["id"], next.items[0]["id"]);
    assert!(next.next_cursor.is_none());
    request.entity_id = Some(Uuid::new_v4());
    assert!(grids::validate("audit", &request).is_err());
    request.cursor = None;
    assert_eq!(
        grids::page(&mut conn, "audit", &request, None)
            .await
            .unwrap()
            .total_count,
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn numeric_entity_id_search_sort_export_and_uuid_compatibility(pool: PgPool) {
    let mut ids = Vec::new();
    for n in 1..=12 {
        let id = Uuid::new_v4();
        let entity_id: i64 = sqlx::query_scalar(
            "INSERT INTO catalog.categories(id,name,slug) VALUES($1,$2,$3) RETURNING entity_id",
        )
        .bind(id)
        .bind(format!("Category {}", (b'A' + n - 1) as char))
        .bind(format!("numeric-id-{n}"))
        .fetch_one(&pool)
        .await
        .unwrap();
        ids.push((id, entity_id));
    }
    let mut conn = pool.acquire().await.unwrap();
    for descending in [false, true] {
        let mut request = grids::Request {
            sort: Some("entity_id".into()),
            limit: Some(3),
            descending,
            ..Default::default()
        };
        let mut actual = Vec::new();
        loop {
            let page = grids::page(&mut conn, "categories", &request, None)
                .await
                .unwrap();
            for row in page.items {
                actual.push((
                    serde_json::from_value::<Uuid>(row["id"].clone()).unwrap(),
                    row["entity_id"].as_i64().unwrap(),
                ));
            }
            request.cursor = page.next_cursor;
            if request.cursor.is_none() {
                break;
            }
        }
        let expected: Vec<_> = if descending {
            ids.iter().rev().copied().collect()
        } else {
            ids.clone()
        };
        assert_eq!(
            actual, expected,
            "numeric ordering must cross the 9/10 boundary"
        );
    }
    for query in [ids[9].1.to_string(), format!("#{}", ids[9].1)] {
        let page = grids::page(
            &mut conn,
            "categories",
            &grids::Request {
                q: query,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.total_count, 1);
        assert_eq!(page.items[0]["id"], json!(ids[9].0));
        assert_eq!(page.items[0]["entity_id"], ids[9].1);
    }
    exports::validate(&exports::Input {
        grid: "categories".into(),
        request: Default::default(),
        columns: vec!["entity_id".into(), "id".into()],
        format: "csv".into(),
    })
    .unwrap();
    assert!(grids::sorts("audit")
        .unwrap()
        .iter()
        .all(|sort| *sort != "entity_id"));
    // Existing audit UUID target filtering keeps its original contract.
    grids::validate(
        "audit",
        &grids::Request {
            entity_id: Some(ids[0].0),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(grids::validate(
        "categories",
        &grids::Request {
            entity_id: Some(ids[0].0),
            ..Default::default()
        }
    )
    .is_err());
}
