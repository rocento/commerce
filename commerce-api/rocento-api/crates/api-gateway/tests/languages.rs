use api_gateway::{identity, localization};
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Router, Uuid) {
    let security = Security::new(
        "languages-test-secret-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'translator',ARRAY['languages.read','languages.write','catalog.read','catalog.write'])").bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'translator@test.local','Translator','!',$2)").bind(user).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("translation-test")).bind(user).execute(pool).await.unwrap();
    (
        {
            let app =
                identity::App::new(pool.clone(), security, vec!["http://localhost:5174".into()]);
            localization::router(app.clone())
                .merge(localization::public_router(app.clone()))
                .merge(api_gateway::admin_depth::router(app))
        },
        role,
    )
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    session: bool,
    csrf: bool,
) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if session {
        req = req.header("cookie", "admin_session=translation-test");
    }
    if csrf {
        req = req.header("x-commerce-request", "1");
    }
    let response = app
        .clone()
        .oneshot(
            req.body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn arabic() -> Value {
    json!({"locale":"ar","name":"Arabic","native_name":"العربية","direction":"rtl","expected_revision":0})
}

#[sqlx::test(migrations = "../../migrations")]
async fn configured_languages_are_visible_without_admin_session(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    let initial = request(&app, "GET", "/v1/languages", None, false, false).await;
    assert_eq!(initial.0, 200);
    assert_eq!(initial.1["source_locale"], "en");
    let saved = request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    assert_eq!(saved.0, 200);
    let public = request(&app, "GET", "/v1/languages", None, false, false).await;
    assert_eq!(public.0, 200);
    assert!(public.1["languages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|language| language["locale"] == "ar"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn languages_require_permissions_csrf_and_optimistic_revisions(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    assert_eq!(
        request(&app, "GET", "/v1/admin/languages", None, false, false)
            .await
            .0,
        401
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(arabic()),
            true,
            false
        )
        .await
        .0,
        403
    );
    let initial = request(&app, "GET", "/v1/admin/languages", None, true, false).await;
    assert_eq!(initial.0, 200);
    assert_eq!(initial.1["source_locale"], "en");
    assert_eq!(initial.1["publication_available"], false);
    let saved = request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    assert_eq!(saved.0, 200);
    assert_eq!(saved.1["revision"], 1);
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(arabic()),
            true,
            true
        )
        .await
        .0,
        409
    );
    let mut update = arabic();
    update["expected_revision"] = json!(1);
    update["name"] = json!("Arabic language");
    let (a, b) = tokio::join!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(update.clone()),
            true,
            true
        ),
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(update),
            true,
            true
        )
    );
    assert!((a.0 == 200 && b.0 == 409) || (a.0 == 409 && b.0 == 200));
    let mut source = arabic();
    source["locale"] = json!("en");
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(source),
            true,
            true
        )
        .await
        .0,
        400
    );
    let mut publish = arabic();
    publish["published"] = json!(true);
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(publish),
            true,
            true
        )
        .await
        .0,
        422
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(arabic()),
            true,
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/admin/languages/ar/translations",
            None,
            true,
            false
        )
        .await
        .0,
        403
    );
    let public_locale: String = sqlx::query_scalar(
        "SELECT default_locale FROM cms.discoverability_settings WHERE singleton",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(public_locale, "en");
}

#[sqlx::test(migrations = "../../migrations")]
async fn translation_review_detects_source_changes_and_preserves_commerce(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Fruit','fruit')")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,active,in_stock,category_id) VALUES($1,'TEST-APPLE','test-apple','Apple','Fresh apple',12,'USD','each',true,true,$1)").bind(id).execute(&pool).await.unwrap();
    let path = format!("/v1/admin/languages/ar/translations/product/{id}");
    let source = json!({"name":"Apple","description":"Fresh apple"});
    let fields = json!({"name":"تفاح","description":"تفاح طازج"});
    let input = json!({"expected_revision":0,"source":source,"fields":fields,"reviewed":true});
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        409
    );
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(list["reviewed"], 1);
    assert_eq!(list["items"][0]["status"], "reviewed");
    sqlx::query("UPDATE catalog.products SET price=15 WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(list["reviewed"], 1); // Price changes do not invalidate text translation.
    sqlx::query("UPDATE catalog.products SET description='Organic apple' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(list["needs_review"], 1);
    assert_eq!(list["reviewed"], 0);
    let mut stale = input.clone();
    stale["expected_revision"] = json!(1);
    assert_eq!(
        request(&app, "PUT", &path, Some(stale.clone()), true, true)
            .await
            .0,
        409
    );
    stale["source"] = json!({"name":"Apple","description":"Organic apple"});
    stale["fields"]["price"] = json!("0");
    assert_eq!(
        request(&app, "PUT", &path, Some(stale.clone()), true, true)
            .await
            .0,
        400
    );
    stale["fields"] = json!({"name":"تفاح"});
    assert_eq!(
        request(&app, "PUT", &path, Some(stale.clone()), true, true)
            .await
            .0,
        400
    );
    stale["reviewed"] = json!(false);
    assert_eq!(
        request(&app, "PUT", &path, Some(stale.clone()), true, true)
            .await
            .0,
        200
    );
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(list["draft"], 1);
    assert_eq!(list["needs_review"], 0);
    let values: (String, String, String) =
        sqlx::query_as("SELECT name,price::text,sku FROM catalog.products WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        values,
        ("Apple".into(), "15.00".into(), "TEST-APPLE".into())
    );
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM admin_iam.audit_log WHERE action='languages.translation.saved'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 2);
    sqlx::query("DELETE FROM catalog.products WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "PUT", &path, Some(stale), true, true).await.0,
        404
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/admin/languages/ar/translations",
            None,
            true,
            false
        )
        .await
        .1["total"],
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn translation_pagination_and_category_allowlist(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) SELECT gen_random_uuid(),'Category '||i,'category-'||i FROM generate_series(1,51) i").execute(&pool).await.unwrap();
    let first = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations?kind=category",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(first["total"], 51);
    assert_eq!(first["missing"], 51);
    let second = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations?kind=category&offset=50",
        None,
        true,
        false,
    )
    .await
    .1;
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    let direct_path = format!(
        "/v1/admin/languages/ar/translations/category/{}",
        second["items"][0]["entity_id"].as_str().unwrap()
    );
    let direct = request(&app, "GET", &direct_path, None, true, false).await;
    assert_eq!(direct.0, 200);
    assert_eq!(direct.1, second["items"][0]);
    let row = &first["items"][0];
    let path = format!(
        "/v1/admin/languages/ar/translations/category/{}",
        row["entity_id"].as_str().unwrap()
    );
    let mut input = json!({"expected_revision":0,"source":row["source"],"fields":{"name":"فئة"},"reviewed":true});
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    input["fields"]["slug"] = json!("other");
    assert_eq!(
        request(&app, "PUT", &path, Some(input), true, true).await.0,
        400
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/admin/languages/ar/translations?kind=category&q=Category%2051",
            None,
            true,
            false
        )
        .await
        .1["total"],
        1
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/admin/languages/fr/translations",
            None,
            true,
            false
        )
        .await
        .0,
        404
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/admin/languages/ar/translations?offset=-1",
            None,
            true,
            false
        )
        .await
        .0,
        400
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn interface_csv_preview_is_read_only_import_is_atomic_and_revision_guarded(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    let base = "/v1/admin/languages/interface";
    let bundle = request(&app, "GET", base, None, true, false).await;
    assert_eq!(bundle.0, 200);
    let csv = "key,en,ar\ncart.add,Buy now,اشتر الآن\n";
    let preview = request(
        &app,
        "POST",
        &format!("{base}/preview"),
        Some(json!({"csv":csv})),
        true,
        true,
    )
    .await;
    assert_eq!(preview.0, 200);
    assert_eq!(preview.1["errors"], json!([]));
    assert_eq!(preview.1["changes"].as_array().unwrap().len(), 2);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM cms.interface_translations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let payload = json!({"csv":csv,"expected_revision":preview.1["revision"],"catalog_version":preview.1["catalog_version"]});
    let import_path = format!("{base}/import");
    let (one, two) = tokio::join!(
        request(&app, "PUT", &import_path, Some(payload.clone()), true, true),
        request(&app, "PUT", &import_path, Some(payload), true, true)
    );
    assert!((one.0 == 200 && two.0 == 409) || (one.0 == 409 && two.0 == 200));
    let bundle = request(&app, "GET", base, None, true, false).await.1;
    assert_eq!(bundle["overrides"].as_array().unwrap().len(), 2);
    let invalid = "key,en,ar\ncart.add,Should not save,\ncart.remove_item,Missing placeholder,\n";
    let preview = request(
        &app,
        "POST",
        &format!("{base}/preview"),
        Some(json!({"csv":invalid})),
        true,
        true,
    )
    .await
    .1;
    assert_eq!(preview["errors"].as_array().unwrap().len(), 1);
    assert_eq!(request(&app,"PUT",&format!("{base}/import"),Some(json!({"csv":invalid,"expected_revision":bundle["revision"],"catalog_version":bundle["catalog_version"]})),true,true).await.0,400);
    let text: String = sqlx::query_scalar(
        "SELECT text FROM cms.interface_translations WHERE message_key='cart.add' AND locale='en'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(text, "Buy now");
    let after = request(&app, "GET", base, None, true, false).await.1;
    assert_eq!(after["revision"], bundle["revision"]);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM admin_iam.audit_log WHERE action='languages.interface.imported'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let no_op=request(&app,"PUT",&format!("{base}/import"),Some(json!({"csv":csv,"expected_revision":bundle["revision"],"catalog_version":bundle["catalog_version"]})),true,true).await;
    assert_eq!(no_op.0, 200);
    assert_eq!(no_op.1["changed"], 0);
    assert_eq!(no_op.1["revision"], bundle["revision"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn interface_editor_export_and_import_share_storage_and_permissions(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    let base = "/v1/admin/languages/interface";
    assert_eq!(request(&app, "GET", base, None, false, false).await.0, 401);
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{base}/preview"),
            Some(json!({"csv":"key,en"})),
            true,
            false
        )
        .await
        .0,
        403
    );
    let bundle = request(&app, "GET", base, None, true, false).await.1;
    let payload = json!({"key":"cart.add","locale":"en","form":"other","text":"=SUM(1,2)","expected_revision":bundle["revision"],"catalog_version":bundle["catalog_version"]});
    assert_eq!(
        request(&app, "PUT", base, Some(payload.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "PUT", base, Some(payload.clone()), true, true)
            .await
            .0,
        409
    );
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("{base}/export"))
                .header("cookie", "admin_session=translation-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "text/csv; charset=utf-8"
    );
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let csv = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("'=SUM(1,2)"));
    let preview = request(
        &app,
        "POST",
        &format!("{base}/preview"),
        Some(json!({"csv":csv})),
        true,
        true,
    )
    .await
    .1;
    assert_eq!(preview["errors"], json!([]));
    assert_eq!(preview["changes"], json!([]));
    let mut reset = payload.clone();
    reset["expected_revision"] = json!(2);
    reset["text"] = Value::Null;
    assert_eq!(
        request(&app, "PUT", base, Some(reset), true, true).await.0,
        200
    );
    assert_eq!(
        request(&app, "GET", base, None, true, false).await.1["overrides"],
        json!([])
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(request(&app, "GET", base, None, true, false).await.0, 200);
    assert_eq!(
        request(&app, "PUT", base, Some(payload), true, true)
            .await
            .0,
        403
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{base}/preview"),
            Some(json!({"csv":"key,en"})),
            true,
            true
        )
        .await
        .0,
        403
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn interface_csv_accepts_large_valid_preview_and_checks_catalog_version(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    let base = "/v1/admin/languages/interface";
    let bundle = request(&app, "GET", base, None, true, false).await.1;
    let mut csv = String::from("key,en\n");
    for message in bundle["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["plural"].is_null() && !m["en"]["other"].as_str().unwrap().contains('{'))
        .take(30)
    {
        csv.push_str(&format!(
            "{},{}\n",
            message["key"].as_str().unwrap(),
            "x".repeat(3000)
        ));
    }
    assert!(csv.len() > 64 * 1024);
    let preview = request(
        &app,
        "POST",
        &format!("{base}/preview"),
        Some(json!({"csv":csv})),
        true,
        true,
    )
    .await;
    assert_eq!(preview.0, 200);
    assert_eq!(preview.1["errors"], json!([]));
    assert_eq!(preview.1["changes"].as_array().unwrap().len(), 30);
    let result = request(
        &app,
        "PUT",
        &format!("{base}/import"),
        Some(
            json!({"csv":csv,"expected_revision":bundle["revision"],"catalog_version":"old-build"}),
        ),
        true,
        true,
    )
    .await;
    assert_eq!(result.0, 409);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM cms.interface_translations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn entity_translation_lookup_and_navigation_scope_preserve_source(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    let id = Uuid::new_v4();
    let user: Uuid = sqlx::query_scalar("SELECT id FROM admin_iam.admin_users WHERE role_id=$1")
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
    let blocks = json!([{"kind":"link","link_label":"Shop","link_url":"/search","navigation":{"badge":"New","links":[{"label":"Fruit","group":"Fresh","description":"Seasonal fruit","url":"/categories/fruit"}]}}]);
    sqlx::query(
        "INSERT INTO cms.documents(id,key,kind,version) VALUES($1,'navigation','navigation',1)",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES($1,$2,1,'Main menu',$3,$4)").bind(Uuid::new_v4()).bind(id).bind(&blocks).bind(user).execute(&pool).await.unwrap();
    let path = format!("/v1/admin/languages/ar/translations/navigation/{id}");
    // Catalog access alone must never expose CMS content.
    assert_eq!(request(&app, "GET", &path, None, true, false).await.0, 403);
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read','languages.write','cms.read','cms.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let loaded = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(loaded.0, 200);
    assert_eq!(loaded.1["status"], "missing");
    assert_eq!(loaded.1["source"]["item.0.link.0.group"], "Fresh");
    assert_eq!(loaded.1["source"]["__version"], "1");
    let input = json!({"expected_revision":0,"source":loaded.1["source"],"fields":{"title":"القائمة","item.0.label":"تسوق","item.0.badge":"جديد","item.0.link.0.label":"فواكه","item.0.link.0.group":"طازج","item.0.link.0.description":"فواكه موسمية"},"reviewed":true});
    let mut invalid = input.clone();
    invalid["fields"]["item.0.link.0.url"] = json!("https://example.com");
    assert_eq!(
        request(&app, "PUT", &path, Some(invalid), true, true)
            .await
            .0,
        400
    );
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        409
    );
    let saved = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(saved.1["status"], "reviewed");
    let stored: Value =
        sqlx::query_scalar("SELECT blocks FROM cms.revisions WHERE document_id=$1 AND version=1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, blocks);
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES($1,$2,2,'Main menu',$3,$4)").bind(Uuid::new_v4()).bind(id).bind(&blocks).bind(user).execute(&pool).await.unwrap();
    sqlx::query("UPDATE cms.documents SET version=2 WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let changed = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(changed.1["status"], "needs_review");
    let mut stale = input.clone();
    stale["expected_revision"] = json!(1);
    assert_eq!(
        request(&app, "PUT", &path, Some(stale), true, true).await.0,
        409
    );
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations?kind=navigation",
        None,
        true,
        false,
    )
    .await;
    assert_eq!(list.0, 200);
    assert_eq!(list.1["needs_review"], 1);
    let missing = format!(
        "/v1/admin/languages/ar/translations/navigation/{}",
        Uuid::new_v4()
    );
    assert_eq!(
        request(&app, "GET", &missing, None, true, false).await.0,
        404
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &path.replace("/ar/", "/fr/"),
            None,
            true,
            false
        )
        .await
        .0,
        404
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read','languages.write','cms.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, "PUT", &path, Some(input), true, true).await.0,
        403
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/v1/admin/languages/ar/translations/product/{id}"),
            None,
            true,
            false
        )
        .await
        .0,
        403
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn published_navigation_releases_include_reviewed_translations_only(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read','languages.write','cms.read','cms.write','cms.publish'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/languages",
            Some(arabic()),
            true,
            true
        )
        .await
        .0,
        200
    );
    let blocks = json!([{"kind":"link","heading":"","text":"","image_id":null,"link_label":"Shop","link_url":"/search","navigation":{"icon":"🛍","badge":"New","enabled":true,"new_tab":false,"columns":2,"links":[{"label":"Fruit","group":"Fresh","description":"Seasonal fruit","url":"/categories/fruit","icon":"🍎","new_tab":false}]}}]);
    let saved = request(&app, "POST", "/v1/admin/content", Some(json!({"key":"navigation","kind":"navigation","expected_version":0,"title":"Menu","blocks":blocks})), true, true).await;
    assert_eq!(saved.0, 200, "{saved:?}");
    let id = saved.1["document_id"].as_str().unwrap();
    let path = format!("/v1/admin/languages/ar/translations/navigation/{id}");
    let loaded = request(&app, "GET", &path, None, true, false).await;
    let fields = json!({"title":"القائمة","item.0.label":"تسوق","item.0.badge":"جديد","item.0.link.0.label":"فواكه","item.0.link.0.group":"طازج","item.0.link.0.description":"فواكه موسمية"});
    let input =
        json!({"expected_revision":0,"source":loaded.1["source"],"fields":fields,"reviewed":true});
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    // Neither source nor translation is public before a release.
    assert!(request(
        &app,
        "GET",
        "/v1/content/navigation?locale=ar",
        None,
        false,
        false
    )
    .await
    .1
    .is_null());
    let release_path = format!("/v1/admin/content/{id}/releases");
    let publish = json!({"revision_id":saved.1["id"],"starts_at":null,"ends_at":null});
    assert_eq!(
        request(
            &app,
            "POST",
            &release_path,
            Some(publish.clone()),
            true,
            true
        )
        .await
        .0,
        200
    );
    let ar = request(
        &app,
        "GET",
        "/v1/content/navigation?locale=ar",
        None,
        false,
        false,
    )
    .await;
    assert_eq!(ar.0, 200);
    assert_eq!(ar.1["blocks"][0]["link_label"], "تسوق");
    assert_eq!(ar.1["blocks"][0]["navigation"]["links"][0]["group"], "طازج");
    assert_eq!(
        ar.1["blocks"][0]["navigation"]["links"][0]["url"],
        "/categories/fruit"
    );
    for suffix in ["", "?locale=en", "?locale=fr"] {
        let en = request(
            &app,
            "GET",
            &format!("/v1/content/navigation{suffix}"),
            None,
            false,
            false,
        )
        .await;
        assert_eq!(en.1["blocks"], blocks);
    }
    // Reviewed edits also remain private until republished.
    let mut edited = input.clone();
    edited["expected_revision"] = json!(1);
    edited["fields"]["item.0.label"] = json!("تسوق الآن");
    assert_eq!(
        request(&app, "PUT", &path, Some(edited.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/content/navigation?locale=ar",
            None,
            false,
            false
        )
        .await
        .1,
        ar.1
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &release_path,
            Some(publish.clone()),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/content/navigation?locale=ar",
            None,
            false,
            false
        )
        .await
        .1["blocks"][0]["link_label"],
        "تسوق الآن"
    );
    edited["expected_revision"] = json!(2);
    edited["reviewed"] = json!(false);
    assert_eq!(
        request(&app, "PUT", &path, Some(edited), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &release_path,
            Some(publish.clone()),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/content/navigation?locale=ar",
            None,
            false,
            false
        )
        .await
        .1["blocks"],
        blocks
    );
    // Stale position-based translations cannot attach to a changed source revision.
    let mut reviewed = input;
    reviewed["expected_revision"] = json!(3);
    assert_eq!(
        request(&app, "PUT", &path, Some(reviewed), true, true)
            .await
            .0,
        200
    );
    let next = request(&app,"POST","/v1/admin/content",Some(json!({"key":"navigation","kind":"navigation","expected_version":1,"title":"New menu","blocks":blocks})),true,true).await;
    assert_eq!(next.0, 200);
    let mut publish_next = publish;
    publish_next["revision_id"] = next.1["id"].clone();
    assert_eq!(
        request(&app, "POST", &release_path, Some(publish_next), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/content/navigation?locale=ar",
            None,
            false,
            false
        )
        .await
        .1["blocks"],
        blocks
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &release_path,
            Some(json!({"revision_id":null,"starts_at":null,"ends_at":null})),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert!(request(
        &app,
        "GET",
        "/v1/content/navigation?locale=ar",
        None,
        false,
        false
    )
    .await
    .1
    .is_null());
}

#[sqlx::test(migrations = "../../migrations")]
async fn catalog_attribute_translations_are_scoped_and_revision_checked(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    let id = Uuid::new_v4();
    let definition = Uuid::new_v4();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,metadata,options) VALUES($1,'product','finish','Finish','text','{\"description\":\"Surface finish\"}','[{\"value\":\"polished.gold\",\"label\":\"Polished gold\",\"labels\":{\"ar\":\"ذهبي\"}}]')").bind(definition).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Jewelry','jewelry')")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES($1,'RING','ring','Ring','Gold ring',12,'USD','each',$1,'{\"finish\":\"Polished\",\"weight\":5}')").bind(id).execute(&pool).await.unwrap();
    let path = format!("/v1/admin/languages/ar/translations/attribute/{definition}");
    assert_eq!(request(&app, "GET", &path, None, true, false).await.0, 403);
    sqlx::query("UPDATE admin_iam.roles SET permissions=permissions||ARRAY['attributes.read','attributes.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let loaded = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(loaded.0, 200);
    assert_eq!(loaded.1["source"]["option.polished.gold"], "Polished gold");
    assert_eq!(loaded.1["fields"]["option.polished.gold"], "ذهبي");
    let fields =
        json!({"label":"التشطيب","description":"تشطيب السطح","option.polished.gold":"ذهبي لامع"});
    let input =
        json!({"expected_revision":0,"source":loaded.1["source"],"fields":fields,"reviewed":true});
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        409
    );
    let list = request(
        &app,
        "GET",
        "/v1/admin/languages/ar/translations?kind=attribute",
        None,
        true,
        false,
    )
    .await;
    assert_eq!(list.0, 200);
    assert_eq!(list.1["reviewed"], 1);
    let product_path = format!("/v1/admin/languages/ar/translations/product/{id}");
    let source = request(&app, "GET", &product_path, None, true, false)
        .await
        .1["source"]
        .clone();
    assert_eq!(source["attribute.finish"], "Polished");
    assert!(source.get("attribute.weight").is_none());
    let mut product_input = json!({"expected_revision":0,"source":source,"fields":{"name":"خاتم","description":"خاتم ذهب"},"reviewed":true});
    assert_eq!(
        request(
            &app,
            "PUT",
            &product_path,
            Some(product_input.clone()),
            true,
            true
        )
        .await
        .0,
        400
    );
    product_input["fields"]["attribute.finish"] = json!("لامع");
    assert_eq!(
        request(
            &app,
            "PUT",
            &product_path,
            Some(product_input.clone()),
            true,
            true
        )
        .await
        .0,
        200
    );
    sqlx::query("UPDATE catalog.products SET attributes=jsonb_set(attributes,'{finish}','\"Matte\"') WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, "GET", &product_path, None, true, false)
            .await
            .1["status"],
        "needs_review"
    );
    product_input["expected_revision"] = json!(1);
    assert_eq!(
        request(&app, "PUT", &product_path, Some(product_input), true, true)
            .await
            .0,
        409
    );
    let stored: (String, Value) =
        sqlx::query_as("SELECT label,options FROM attributes.definitions WHERE id=$1")
            .bind(definition)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored.0, "Finish");
    assert_eq!(stored.1[0]["value"], "polished.gold");
    sqlx::query("UPDATE attributes.definitions SET options='[]' WHERE id=$1")
        .bind(definition)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", &path, None, true, false).await.1["status"],
        "needs_review"
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['languages.read','languages.write','attributes.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, "PUT", &path, Some(input), true, true).await.0,
        403
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn customer_attribute_labels_use_configured_language_workflow(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    request(
        &app,
        "POST",
        "/v1/admin/languages",
        Some(arabic()),
        true,
        true,
    )
    .await;
    sqlx::query("UPDATE admin_iam.roles SET permissions=permissions||ARRAY['attributes.read','attributes.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,options) VALUES($1,'customer','preferred_color','Preferred color','select','[{\"value\":\"red\",\"label\":\"Red\",\"labels\":{\"ar\":\"أحمر\"}}]')").bind(id).execute(&pool).await.unwrap();
    let path = format!("/v1/admin/languages/ar/translations/attribute/{id}");
    let loaded = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(loaded.0, 200);
    assert_eq!(loaded.1["fields"]["option.red"], "أحمر");
    let saved = request(&app, "PUT", &path, Some(json!({"expected_revision":0,"source":loaded.1["source"],"fields":{"label":"اللون المفضل","option.red":"أحمر"},"reviewed":true})), true, true).await;
    assert_eq!(saved.0, 200);
    let original: (String, Value) =
        sqlx::query_as("SELECT label,options FROM attributes.definitions WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(original.0, "Preferred color");
    assert_eq!(original.1[0]["value"], "red");
    assert_eq!(original.1[0]["label"], "Red");
}

#[sqlx::test(migrations = "../../migrations")]
async fn saved_interface_phrases_are_public_and_stale_sources_fall_back(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    let base = "/v1/admin/languages/interface";
    let bundle = request(&app, "GET", base, None, true, false).await.1;
    let saved = request(
        &app,
        "PUT",
        base,
        Some(json!({
            "key":"navigation.account","locale":"ar","form":"other","text":"مساحة حسابي",
            "expected_revision":bundle["revision"],"catalog_version":bundle["catalog_version"]
        })),
        true,
        true,
    )
    .await;
    assert_eq!(saved.0, 200);
    let response = app
        .clone()
        .oneshot(
            Request::get("/v1/languages/interface")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let public: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(public["revision"], saved.1["revision"]);
    assert!(public["overrides"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["key"] == "navigation.account" && o["text"] == "مساحة حسابي"));
    assert_eq!(
        request(&app, "PUT", "/v1/languages/interface", None, false, false)
            .await
            .0,
        405
    );
    // An old source phrase must never replace the current default.
    sqlx::query("UPDATE cms.interface_translations SET source_text='obsolete' WHERE message_key='navigation.account'")
        .execute(&pool).await.unwrap();
    let public = request(&app, "GET", "/v1/languages/interface", None, false, false).await;
    assert_eq!(public.0, 200);
    assert!(!public.1["overrides"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["key"] == "navigation.account"));
}
