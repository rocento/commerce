use domain_catalog::{
    media_library::{FolderInput, LibraryQuery, MoveMediaInput},
    Media, Service,
};
use sqlx::PgPool;
use uuid::Uuid;
fn input(name: &str, parent_id: Option<Uuid>) -> FolderInput {
    FolderInput {
        name: name.into(),
        parent_id,
    }
}
fn media(name: &str) -> Media {
    let id = Uuid::new_v4();
    Media {
        id,
        entity_id: 0,
        content_type: "image/png".into(),
        alt: name.into(),
        object_key: format!("catalog/{id}"),
        size_bytes: 128,
    }
}
fn query(folder: &str) -> LibraryQuery {
    LibraryQuery {
        folder: Some(folder.into()),
        ..Default::default()
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn media_folders_validate_hierarchy_and_preserve_images(pool: PgPool) {
    let service = Service { pool };
    let root = service
        .save_media_folder(None, input("Summer", None))
        .await
        .unwrap();
    let child = service
        .save_media_folder(None, input("Products", Some(root.id)))
        .await
        .unwrap();
    assert!(service
        .save_media_folder(None, input(" summer ", None))
        .await
        .is_err());
    assert!(service
        .save_media_folder(Some(root.id), input("Summer", Some(child.id)))
        .await
        .is_err());
    assert!(service
        .save_media_folder(None, input("Missing parent", Some(Uuid::new_v4())))
        .await
        .is_err());
    let image = service
        .add_media_to_folder(
            media("Tahini jar"),
            Some(child.id),
            "C:\\fakepath\\tahini.png".into(),
        )
        .await
        .unwrap();
    let page = service
        .media_library(query(&child.id.to_string()))
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].file_name, "tahini.png");
    assert_eq!(page.items[0].media.id, image.id);
    assert!(root.entity_id > 0 && child.entity_id > 0 && image.entity_id > 0);
    assert_ne!(root.entity_id, child.entity_id);
    assert_eq!(page.items[0].media.entity_id, image.entity_id);
    let renamed = service
        .save_media_folder(Some(child.id), input("Grocery", None))
        .await
        .unwrap();
    assert_eq!(renamed.entity_id, child.entity_id);
    assert_eq!(
        service.media_by_id(image.id).await.unwrap().object_key,
        image.object_key
    );
    service
        .move_media(MoveMediaInput {
            ids: vec![image.id],
            folder_id: Some(root.id),
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .media_library(query(&child.id.to_string()))
            .await
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        service
            .media_library(query(&root.id.to_string()))
            .await
            .unwrap()
            .total,
        1
    );
    service.delete_media_folder(root.id).await.unwrap();
    assert_eq!(
        service.media_library(query("unfiled")).await.unwrap().items[0]
            .media
            .id,
        image.id
    );
    assert_eq!(
        service.media_by_id(image.id).await.unwrap().object_key,
        image.object_key
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn media_moves_are_atomic_and_folder_delete_detaches_descendants(pool: PgPool) {
    let service = Service { pool };
    let root = service
        .save_media_folder(None, input("Catalog", None))
        .await
        .unwrap();
    let child = service
        .save_media_folder(None, input("Pantry", Some(root.id)))
        .await
        .unwrap();
    let image = service
        .add_media_to_folder(media("100% pantry"), Some(child.id), "pantry.png".into())
        .await
        .unwrap();
    assert!(service
        .move_media(MoveMediaInput {
            ids: vec![image.id, Uuid::new_v4()],
            folder_id: Some(root.id)
        })
        .await
        .is_err());
    assert_eq!(
        service
            .media_library(query(&child.id.to_string()))
            .await
            .unwrap()
            .total,
        1
    );
    assert!(service
        .move_media(MoveMediaInput {
            ids: vec![image.id],
            folder_id: Some(Uuid::new_v4())
        })
        .await
        .is_err());
    assert_eq!(
        service
            .media_library(LibraryQuery {
                q: Some("%".into()),
                ..query("all")
            })
            .await
            .unwrap()
            .total,
        1
    );
    service.delete_media_folder(root.id).await.unwrap();
    assert!(service.media_folders().await.unwrap().is_empty());
    assert_eq!(
        service.media_library(query("unfiled")).await.unwrap().total,
        1
    );
    assert_eq!(service.media_by_id(image.id).await.unwrap().id, image.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn media_library_search_and_pagination_are_server_side(pool: PgPool) {
    let service = Service { pool };
    for index in 0..52 {
        service
            .add_media_to_folder(
                media(&format!("Photo {index}")),
                None,
                format!("file-{index}.png"),
            )
            .await
            .unwrap();
    }
    let first = service.media_library(query("unfiled")).await.unwrap();
    let second = service
        .media_library(LibraryQuery {
            offset: Some(48),
            ..query("unfiled")
        })
        .await
        .unwrap();
    assert_eq!(first.total, 52);
    assert_eq!(first.items.len(), 48);
    assert_eq!(second.items.len(), 4);
    assert!(second.items.iter().all(|item| !first
        .items
        .iter()
        .any(|first| first.media.id == item.media.id)));
    let found = service
        .media_library(LibraryQuery {
            q: Some("file-51".into()),
            ..query("all")
        })
        .await
        .unwrap();
    assert_eq!(found.total, 1);
    assert_eq!(found.items[0].media.alt, "Photo 51");
}

#[sqlx::test(migrations = "../../migrations")]
async fn legacy_media_paths_become_persistent_folders(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let mut image = media("Legacy image");
    image.object_key = format!("grocery/pantry/{}", image.id);
    let image = service.add_media(image).await.unwrap();
    let migration = include_str!("../../../migrations/20260921150000_media_folders.sql");
    let backfill = &migration[migration.find("DO $$").unwrap()..];
    sqlx::raw_sql(backfill).execute(&pool).await.unwrap();
    let folders = service.media_folders().await.unwrap();
    let grocery = folders
        .iter()
        .find(|folder| folder.name == "grocery")
        .unwrap();
    let pantry = folders
        .iter()
        .find(|folder| folder.name == "pantry")
        .unwrap();
    assert_eq!(pantry.parent_id, Some(grocery.id));
    assert_eq!(
        service
            .media_library(query(&pantry.id.to_string()))
            .await
            .unwrap()
            .items[0]
            .media
            .id,
        image.id
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn media_folder_http_requires_permissions_and_csrf(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;
    let security = infra_auth::Security::new(
        "media-folder-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let identity = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5174".into()],
    );
    identity
        .admins
        .seed("admin@example.test", "Testing password 123!".into())
        .await
        .unwrap();
    let (who, admin) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "admin@example.test".into(),
            password: "Testing password 123!".into(),
        })
        .await
        .unwrap();
    let role = identity
        .admins
        .save_role(
            &who,
            None,
            domain_admin_iam::RoleInput {
                name: "Media reader".into(),
                permissions: vec!["catalog.read".into()],
            },
        )
        .await
        .unwrap();
    identity
        .admins
        .save_user(
            &who,
            None,
            domain_admin_iam::UserInput {
                email: "reader@example.test".into(),
                name: "Reader".into(),
                role_id: role.id,
                password: Some("Testing password 123!".into()),
                active: true,
            },
        )
        .await
        .unwrap();
    let (_, reader) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "reader@example.test".into(),
            password: "Testing password 123!".into(),
        })
        .await
        .unwrap();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity,
        catalog: Service { pool },
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    async fn request(
        router: &axum::Router,
        method: &str,
        path: &str,
        token: &str,
        body: serde_json::Value,
        csrf: bool,
    ) -> (u16, serde_json::Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("cookie", format!("admin_session={token}"));
        if csrf {
            request = request.header("x-commerce-request", "1");
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        (status, body)
    }
    let path = "/v1/admin/catalog/media/folders";
    assert_eq!(
        request(&router, "GET", path, "", json!({}), true).await.0,
        401
    );
    assert_eq!(
        request(&router, "GET", path, &reader, json!({}), true)
            .await
            .0,
        200
    );
    let body = json!({"name":"Campaign","parent_id":null});
    assert_eq!(
        request(&router, "POST", path, &reader, body.clone(), true)
            .await
            .0,
        403
    );
    assert_eq!(
        request(&router, "POST", path, &admin, body.clone(), false)
            .await
            .0,
        403
    );
    let (status, folder) = request(&router, "POST", path, &admin, body, true).await;
    assert_eq!(status, 201);
    assert_eq!(folder["name"], "Campaign");
    let path = format!("{path}/{}", folder["id"].as_str().unwrap());
    assert_eq!(
        request(&router, "DELETE", &path, &reader, json!({}), true)
            .await
            .0,
        403
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/admin/catalog/media/library?folder=unfiled",
            &reader,
            json!({}),
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/catalog/media/move",
            &reader,
            json!({"ids":[Uuid::new_v4()],"folder_id":null}),
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(&router, "DELETE", &path, &admin, json!({}), true)
            .await
            .0,
        200
    );
}
