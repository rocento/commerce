//! Bounded deployment preparation for existing storefront images. Never changes originals.
use super::images::store_derived;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

const ELIGIBLE: &str = "FROM catalog.media m JOIN catalog.public_media_ids p ON p.id=m.id LEFT JOIN catalog.publication_images i ON i.media_id=m.id WHERE m.content_type IN ('image/png','image/jpeg','image/webp') AND m.size_bytes BETWEEN 1 AND 5242880 AND (i.media_id IS NULL OR NOT i.variants @> jsonb_build_array(jsonb_build_object('width',i.width)))";

#[derive(FromRow)]
pub struct Candidate {
    pub id: Uuid,
    pub object_key: String,
}

pub async fn candidates(pool: &PgPool, limit: i64) -> Result<Vec<Candidate>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT DISTINCT m.id,m.object_key {ELIGIBLE} ORDER BY m.id LIMIT $1"
    ))
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await
}

pub async fn pending(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT count(DISTINCT m.id) {ELIGIBLE}"))
        .fetch_one(pool)
        .await
}

pub async fn prepare(
    pool: &PgPool,
    store: &infra_media::Store,
    candidate: Candidate,
) -> Result<(), String> {
    let bytes = store
        .get(&candidate.object_key)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("Image exceeds the 5 MB processing limit".into());
    }
    store_derived(pool, store, candidate.id, bytes).await
}
