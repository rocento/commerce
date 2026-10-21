//! Image dimensions and renditions derived from bytes, never guessed from filenames.
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
pub struct Variant {
    pub width: u32,
    pub height: u32,
}
#[derive(Serialize, FromRow)]
pub struct PublicImage {
    pub id: Uuid,
    pub alt: String,
    pub width: i32,
    pub height: i32,
    pub variants: sqlx::types::Json<Vec<Variant>>,
}
pub struct Derived {
    pub width: u32,
    pub height: u32,
    pub variants: Vec<(Variant, Vec<u8>)>,
}
pub fn derive(bytes: &[u8]) -> Result<Derived, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Invalid image")?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err("Use a PNG, JPEG or WebP image".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12000);
    limits.max_image_height = Some(12000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Invalid image or image exceeds processing limits")?;
    let (width, height) = (decoded.width(), decoded.height());
    let mut variants = vec![];
    // High-density screens must not fall back to a multi-megabyte original PNG.
    // Keep a compressed candidate at the original resolution as well as thumbnails.
    for target in [480, 960, width].into_iter().collect::<BTreeSet<_>>() {
        if width >= target {
            let resized = decoded.resize(target, 12000, image::imageops::FilterType::Triangle);
            // Lossless WebP can be larger than a photo's original JPEG. Bound delivery
            // bytes with a quality-controlled derivative; never replace the original.
            let rgba = resized.to_rgba8();
            let encoded =
                webp::Encoder::from_rgba(rgba.as_raw(), resized.width(), resized.height())
                    .encode_simple(false, 82.0)
                    .map_err(|_| "Unable to encode image")?;
            variants.push((
                Variant {
                    width: resized.width(),
                    height: resized.height(),
                },
                encoded.to_vec(),
            ));
        }
    }
    Ok(Derived {
        width,
        height,
        variants,
    })
}
pub async fn for_snapshot(
    db: &mut PgConnection,
    s: &super::snapshot::Snapshot,
    social: Option<Uuid>,
) -> Result<BTreeMap<Uuid, PublicImage>, sqlx::Error> {
    let mut ids = BTreeSet::new();
    ids.extend(social);
    ids.extend(s.merchant.as_ref().and_then(|m| m.logo_id));
    for p in s
        .products
        .iter()
        .chain(s.product.iter())
        .chain(s.family.iter())
        .chain(s.collections.values().flatten())
    {
        ids.extend(p.image_id)
    }
    for c in &s.categories {
        ids.extend(c.thumbnail)
    }
    if let Some(c) = &s.content {
        for b in c.blocks.iter() {
            ids.extend(b.image_id)
        }
    }
    for section in s
        .theme
        .global
        .values()
        .flatten()
        .chain(s.theme.pages.values().flatten())
        .filter(|s| s.enabled)
    {
        if let Some(id) = section
            .settings
            .get("image")
            .and_then(|v| v.as_str())
            .and_then(|v| v.parse().ok())
        {
            ids.insert(id);
        }
    }
    for_ids(db, ids).await
}
/// Only advertise renditions whose manifest was stored after all objects were uploaded.
/// Callers supply media referenced by their already-authorized shopper projection.
pub async fn for_ids(
    db: &mut PgConnection,
    ids: impl IntoIterator<Item = Uuid>,
) -> Result<BTreeMap<Uuid, PublicImage>, sqlx::Error> {
    let ids: Vec<_> = ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let images:Vec<PublicImage>=sqlx::query_as("SELECT m.id,m.alt,i.width,i.height,i.variants FROM catalog.media m JOIN catalog.publication_images i ON i.media_id=m.id WHERE m.id=ANY($1)").bind(ids).fetch_all(db).await?;
    Ok(images.into_iter().map(|i| (i.id, i)).collect())
}
pub async fn is_public(db: &mut PgConnection, id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.public_media_ids WHERE id=$1)")
        .bind(id)
        .fetch_one(db)
        .await
}
/// Uploads are private until a published resource references them. Publish the manifest only
/// after every derived object exists; a failed run can be retried without a partial manifest.
pub async fn store_derived(
    pool: &sqlx::PgPool,
    store: &infra_media::Store,
    id: Uuid,
    bytes: Vec<u8>,
) -> Result<(), String> {
    static PROCESSORS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let permit = PROCESSORS.acquire().await.map_err(|e| e.to_string())?;
    let derived = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        derive(&bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    for (variant, encoded) in &derived.variants {
        store
            .put(
                &format!("catalog/{id}/publication-{}.webp", variant.width),
                encoded,
                "image/webp",
            )
            .await
            .map_err(|e| e.to_string())?;
    }
    let variants: Vec<_> = derived.variants.iter().map(|(v, _)| v.clone()).collect();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height,variants) VALUES($1,$2,$3,$4) ON CONFLICT(media_id) DO UPDATE SET width=$2,height=$3,variants=$4").bind(id).bind(derived.width as i32).bind(derived.height as i32).bind(serde_json::json!(variants)).execute(pool).await.map_err(|e|e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn photographic_derivatives_bound_bytes_and_preserve_alpha() {
        let mut pixels = image::RgbaImage::new(1200, 800);
        for (x, y, p) in pixels.enumerate_pixels_mut() {
            *p = image::Rgba([
                (x % 251) as u8,
                (y % 241) as u8,
                ((x * y) % 239) as u8,
                (x % 256) as u8,
            ]);
        }
        let original = image::DynamicImage::ImageRgba8(pixels);
        let mut png = Cursor::new(vec![]);
        original.write_to(&mut png, ImageFormat::Png).unwrap();
        let result = derive(png.get_ref()).unwrap();
        let mut rows = vec![];
        for (variant, bytes) in result.variants {
            let resized =
                original.resize(variant.width, 12000, image::imageops::FilterType::Triangle);
            let mut lossless = Cursor::new(vec![]);
            resized.write_to(&mut lossless, ImageFormat::WebP).unwrap();
            assert!(
                bytes.len() < lossless.get_ref().len() / 2,
                "derivative should substantially reduce high-detail transfer bytes"
            );
            let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
            let reference = resized.to_rgba8();
            let mut error = 0u64;
            let mut n = 0u64;
            for (a, b) in decoded.pixels().zip(reference.pixels()) {
                assert_eq!(a[3], b[3]);
                if b[3] > 200 {
                    for c in 0..3 {
                        error += a[c].abs_diff(b[c]) as u64;
                        n += 1;
                    }
                }
            }
            let mean_error = error as f64 / n as f64;
            assert!(
                mean_error < 20.,
                "excessive synthetic color error: {mean_error}"
            );
            rows.push(serde_json::json!({"width":variant.width,"height":variant.height,"lossless_bytes":lossless.get_ref().len(),"quality82_bytes":bytes.len(),"opaque_mean_absolute_color_error":mean_error,"alpha_preserved":true}));
        }
        if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                format!("{dir}/image-encoding.json"),
                serde_json::to_vec_pretty(&rows).unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn dimensions_and_real_variants() {
        let image = image::DynamicImage::new_rgb8(1200, 800);
        let mut bytes = Cursor::new(vec![]);
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let d = derive(bytes.get_ref()).unwrap();
        assert_eq!((d.width, d.height), (1200, 800));
        assert_eq!(d.variants.len(), 3);
        for (v, b) in d.variants {
            let i = image::load_from_memory(&b).unwrap();
            assert_eq!((i.width(), i.height()), (v.width, v.height));
        }
        assert!(derive(b"\x89PNG\r\n\x1a\ninvalid").is_err());
    }
}
