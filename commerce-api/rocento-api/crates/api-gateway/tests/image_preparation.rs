use api_gateway::public_commerce::image_preparation;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn preparation_selects_only_referenced_unprepared_images_and_is_repeatable(pool: PgPool) {
    let ids: Vec<_> = (0..6).map(|_| Uuid::new_v4()).collect();
    for (index, id) in ids.iter().enumerate() {
        let content_type = if index == 4 {
            "image/svg+xml"
        } else {
            "image/png"
        };
        let bytes = if index == 5 { 5242881 } else { 2000 };
        sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,$2,'Photo',$3,$4)").bind(id).bind(content_type).bind(format!("catalog/{id}")).bind(bytes as i64).execute(&pool).await.unwrap();
        // Image 3 belongs only to the private media library.
        if index != 3 {
            sqlx::query("INSERT INTO catalog.categories(id,slug,name,attributes) VALUES($1,$2,'Category',jsonb_build_object('thumbnail',$3::text))").bind(Uuid::new_v4()).bind(format!("category-{index}")).bind(id.to_string()).execute(&pool).await.unwrap();
        }
    }
    // Image 1 has only older small candidates. Image 2 is fully prepared.
    for (id, full) in [(ids[1], false), (ids[2], true)] {
        let variants = if full {
            serde_json::json!([{"width":480,"height":480},{"width":1254,"height":1254}])
        } else {
            serde_json::json!([{"width":480,"height":480}])
        };
        sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height,variants) VALUES($1,1254,1254,$2)").bind(id).bind(variants).execute(&pool).await.unwrap();
    }
    assert_eq!(image_preparation::pending(&pool).await.unwrap(), 2);
    let candidates = image_preparation::candidates(&pool, 100).await.unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|i| i.id)
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([ids[0], ids[1]])
    );
    assert_eq!(
        image_preparation::candidates(&pool, 1).await.unwrap().len(),
        1
    );
    for id in [ids[0], ids[1]] {
        sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height,variants) VALUES($1,1254,1254,'[{\"width\":1254,\"height\":1254}]') ON CONFLICT(media_id) DO UPDATE SET variants=excluded.variants").bind(id).execute(&pool).await.unwrap();
    }
    assert_eq!(image_preparation::pending(&pool).await.unwrap(), 0);
    assert!(image_preparation::candidates(&pool, 100)
        .await
        .unwrap()
        .is_empty());
}
